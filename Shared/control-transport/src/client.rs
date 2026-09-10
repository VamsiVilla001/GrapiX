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

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gx_contracts::Refusal;
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{MessageId, Sequence};

/// How long a request waits for its reply before giving up.
///
/// Bounded, because the alternative is an operator pressing take and getting
/// no answer at all. A named timeout refusal is worse than a fast reply and
/// far better than silence.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// A connected control-plane client.
pub struct Client {
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
            stream,
            // Replaced immediately by the exchange below. Never observed.
            capability: placeholder_capability(),
            replies,
            events,
            seq: Sequence(0),
            request_count: 0,
        };

        match client.request(ClientRequest::Capability) {
            Ok(EngineReply::Capability(cap)) => client.capability = cap,
            Ok(other) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("expected a capability reply on connect, got {other:?}"),
                ))
            }
            Err(refusal) => {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionRefused,
                    refusal.to_string(),
                ))
            }
        }

        Ok(client)
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
    }
}
