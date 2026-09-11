//! The control-plane client.
//!
//! Implements `EnginePeer`, which is the point: the conformance suite is
//! written against that trait, so pointing it at a `Client` runs every check
//! over a real socket without changing a line of the suite. That is what makes
//! ADR-001's "the same suite passes at L1 as at L0" a thing you can run rather
//! than a thing you hope.
//!
//! Replies and events arrive interleaved on one stream and are separated by
//! the `reply.` prefix on the envelope id (invariant 34). The prefix rule is
//! not a convention here — it is load-bearing, and this is the code that
//! depends on it.

use crate::Token;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gx_contracts::{Epoch, Refusal};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_plane::status::ProgramState;

/// How long a request waits for its reply before giving up.
///
/// Bounded, because the alternative is an operator pressing take and getting
/// no answer at all. A named timeout refusal is worse than a fast reply and
/// far better than silence.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// What a client learns when it reconnects (ADR B.4).
///
/// Reconciliation is by revision *and* epoch. A matching revision from a new
/// epoch means the engine restarted and rebuilt state that happens to carry
/// the same number, so a client that compared only revisions would carry on
/// with assumptions that no longer hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub previous_epoch: Epoch,
    pub current_epoch: Epoch,
    /// What is on Program now, which may be nothing.
    pub program: Option<ProgramState>,
}

impl Reconciliation {
    /// Whether the engine is a different incarnation than before.
    ///
    /// When true, every cached assumption the client held is void: not stale,
    /// void. There is no partial recovery from a restarted engine.
    pub fn engine_restarted(&self) -> bool {
        self.previous_epoch != self.current_epoch
    }
}

/// A connected control-plane client.
pub struct Client {
    addr: SocketAddr,
    token: Option<Token>,
    stream: TcpStream,
    capability: EngineCapability,
    replies: Receiver<EngineReply>,
    events: Arc<Mutex<Vec<EngineEvent>>>,
    seq: Sequence,
    request_count: u64,
}

impl Client {
    /// Connect and perform the capability exchange.
    ///
    /// Capability is fetched once and cached, because that is when it is
    /// exchanged. A client that re-asked on every access would be pretending
    /// capability can change without a reconnect — and if the engine restarts,
    /// the epoch changes and the connection is gone anyway.
    pub fn connect(addr: SocketAddr) -> io::Result<Self> {
        Self::connect_with(addr, None)
    }

    /// Connect and authenticate before anything else.
    ///
    /// A protected engine refuses every request, capability included, until
    /// the credential is accepted — so this is not an optional extra step, it
    /// is the first one.
    pub fn connect_with_token(addr: SocketAddr, token: Token) -> io::Result<Self> {
        Self::connect_with(addr, Some(token))
    }

    fn connect_with(addr: SocketAddr, token: Option<Token>) -> io::Result<Self> {
        let stream = TcpStream::connect(addr)?;
        stream.set_nodelay(true)?;

        let reader = stream.try_clone()?;
        let (tx, replies) = mpsc::channel();
        let events = Arc::new(Mutex::new(Vec::new()));

        {
            let events = Arc::clone(&events);
            thread::spawn(move || read_loop(reader, tx, events));
        }

        let mut client = Self {
            addr,
            token: token.clone(),
            stream,
            // Replaced immediately by the exchange below. Never observed.
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

        match client.request(ClientRequest::Capability) {
            Ok(EngineReply::Capability(cap)) => client.capability = cap,
            // A refusal here is a real answer and must keep its meaning. An
            // engine that wants a credential and one that is broken are
            // different problems, and a caller can only act differently on
            // them if the error kind says which it was.
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

    /// Redial, re-authenticate, and report what changed (ADR B.4).
    ///
    /// The engine outlives its clients, so a disconnect is not a loss of
    /// Program — it is a loss of knowledge about Program. This asks for that
    /// knowledge back and names the one case where none of it can be trusted:
    /// a new epoch.
    pub fn reconnect(&mut self) -> Result<Reconciliation, Refusal> {
        let previous_epoch = self.capability.epoch;

        let fresh = Self::connect_with(self.addr, self.token.clone()).map_err(|e| {
            Refusal::TransportFailed {
                detail: e.to_string(),
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

    /// Swap the stored credential without reconnecting.
    ///
    /// Exists so a test can prove a reconnect re-authenticates rather than
    /// inheriting the trust of the connection it replaces. Production code
    /// rotates a token by building a new client.
    #[doc(hidden)]
    pub fn replace_token_for_test(&mut self, token: Token) {
        self.token = Some(token);
    }

    /// Send a request and wait for its reply.
    ///
    /// Returns a `Refusal` rather than an `io::Error` for transport problems,
    /// so a caller that already handles refusals cannot forget to handle
    /// unreachability.
    pub fn request(&mut self, request: ClientRequest) -> Result<EngineReply, Refusal> {
        self.seq = self.seq.next();
        self.request_count += 1;

        let envelope = Envelope::new(
            MessageId(format!("req.{}", self.request_count)),
            self.seq,
            request,
        );

        let frame = encode(&envelope).map_err(|e| Refusal::TransportFailed {
            detail: e.to_string(),
        })?;
        self.stream
            .write_all(&frame)
            .and_then(|()| self.stream.flush())
            .map_err(|e| Refusal::TransportFailed {
                detail: e.to_string(),
            })?;

        match self.replies.recv_timeout(REQUEST_TIMEOUT) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => Err(Refusal::TransportFailed {
                detail: format!("no reply within {:?}", REQUEST_TIMEOUT),
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
            // A transport failure is surfaced as the refusal it is, so the
            // conformance suite sees a named outcome rather than a panic.
            Err(refusal) => EngineReply::Refused(refusal),
        }
    }

    fn drain_events(&mut self) -> Vec<EngineEvent> {
        let mut held = self.events.lock().expect("event mutex poisoned");
        std::mem::take(&mut *held)
    }
}

/// Reads frames until the connection ends, routing by envelope id.
fn read_loop(
    mut stream: TcpStream,
    replies: mpsc::Sender<EngineReply>,
    events: Arc<Mutex<Vec<EngineEvent>>>,
) {
    loop {
        let mut prefix = [0u8; LENGTH_PREFIX];
        if stream.read_exact(&mut prefix).is_err() {
            return;
        }
        let Ok(len) = decode_length(prefix) else {
            return;
        };
        let mut body = vec![0u8; len];
        if stream.read_exact(&mut body).is_err() {
            return;
        }

        // Decode the envelope loosely first: the id decides which payload type
        // this is. Matching on the `reply.` prefix rather than on a list of
        // known reply names is what lets an unrecognised reply kind still be
        // routed as a reply (invariant 34).
        let Ok(envelope) = decode_body::<Envelope<serde_json::Value>>(&body) else {
            return;
        };

        if envelope.id.is_reply() {
            match serde_json::from_value::<EngineReply>(envelope.payload) {
                // The receiver being gone means the client was dropped.
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

/// Map a refusal onto the `io::ErrorKind` a caller can branch on.
///
/// Kept as one function so the authentication step and the capability
/// exchange cannot classify the same refusal differently — which they did
/// until a test caught it.
fn kind_for(refusal: &Refusal) -> io::ErrorKind {
    match refusal {
        Refusal::Unauthenticated => io::ErrorKind::PermissionDenied,
        Refusal::TransportFailed { .. } => io::ErrorKind::ConnectionAborted,
        Refusal::ProtocolMismatch { .. } => io::ErrorKind::InvalidData,
        _ => io::ErrorKind::ConnectionRefused,
    }
}

/// A capability that cannot be mistaken for a real one, used only between
/// construction and the exchange a few lines later.
fn placeholder_capability() -> EngineCapability {
    use gx_contracts::{ClockSource, DeviceTier, Epoch, Locality, ReferenceState};
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
