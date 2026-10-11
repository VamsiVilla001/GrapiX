//! The control-plane listener.
//!
//! Generic over `EnginePeer`, so the same server carries a mock today and the
//! real worker later without either of them knowing which local IPC primitive
//! accepted the connection.

use crate::{Claims, Token};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_contracts::Refusal;
use gx_control_plane::bind::{bind_endpoint, BindRefusal, ControlListener, ControlStream, Endpoint};
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::message::{ClientRequest, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{Admission, MessageId, Sequence, SequenceTracker};

/// Why a server could not start.
#[derive(Debug)]
pub enum ServeError {
    /// The single bind policy refused this endpoint (invariant 41).
    Refused(BindRefusal),
    Io(io::Error),
}
impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Refused(refusal) => write!(f, "{refusal}"), Self::Io(error) => write!(f, "{error}") }
    }
}
impl std::error::Error for ServeError {}

/// A control-plane server bound to an endpoint, not yet accepting.
pub struct Server<P: EnginePeer> {
    listener: ControlListener,
    endpoint: Endpoint,
    /// One engine, many clients. The mutex is the engine's serialisation point:
    /// requests are handled one at a time, in arrival order, which is what an
    /// ordered plane promises.
    peer: Arc<Mutex<P>>,
    /// `None` is only reachable on a policy-approved L0 endpoint. The bind
    /// policy owns that decision so the mock cannot weaken the real engine.
    secret: Option<String>,
}

enum ConnectionAuthorization { Unprotected, Authenticated(Claims) }

impl<P: EnginePeer + Send + 'static> Server<P> {
    /// Bind TCP after policy approval. This keeps every existing caller source
    /// compatible; choose [`Self::bind_local`] for the OS local transport.
    pub fn bind(addr: SocketAddr, secret: Option<&str>, peer: P) -> Result<Self, ServeError> {
        Self::bind_endpoint(Endpoint::Tcp(addr), secret, peer)
    }

    /// Bind named-pipe IPC on Windows or a Unix-domain socket on Unix.
    pub fn bind_local(path: impl AsRef<Path>, secret: Option<&str>, peer: P) -> Result<Self, ServeError> {
        Self::bind_endpoint(Endpoint::Local(path.as_ref().to_path_buf()), secret, peer)
    }

    /// Bind a caller-selected endpoint through the one control-plane policy.
    pub fn bind_endpoint(endpoint: Endpoint, secret: Option<&str>, peer: P) -> Result<Self, ServeError> {
        let listener = bind_endpoint(&endpoint, secret).map_err(ServeError::Refused)?;
        Ok(Self { listener, endpoint, peer: Arc::new(Mutex::new(peer)), secret: secret.map(str::to_owned) })
    }

    pub fn engine(&self) -> Arc<Mutex<P>> { Arc::clone(&self.peer) }
    pub fn endpoint(&self) -> &Endpoint { &self.endpoint }

    /// The TCP address actually bound. Local endpoints have no port and name
    /// that mismatch instead of inventing one for compatibility.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        match &self.listener {
            ControlListener::Tcp(listener) => listener.local_addr(),
            #[cfg(any(windows, unix))]
            ControlListener::Local(_) => Err(io::Error::new(io::ErrorKind::Unsupported, "a local control endpoint has no TCP address")),
        }
    }

    /// Accept forever, one thread per connection. The sequencing path below is
    /// shared for TCP and local streams, so locality cannot change delivery
    /// semantics (invariant 13).
    pub fn serve(self) {
        loop {
            match self.listener.accept() {
                Ok(stream) => {
                    let peer = Arc::clone(&self.peer);
                    let secret = self.secret.clone();
                    thread::spawn(move || {
                        if let Err(error) = handle_connection(stream, peer, secret) {
                            eprintln!("control connection closed: {error}");
                        }
                    });
                }
                Err(error) if is_transient(&error) => eprintln!("accept failed, continuing: {error}"),
                Err(error) => { eprintln!("listener stopping: {error}"); return; }
            }
        }
    }

    pub fn serve_in_background(self) -> JoinHandle<()> { thread::spawn(move || self.serve()) }
}

/// A failed accept may be retried only if one connection attempt failed; a
/// persistent listener failure must stop rather than consume a core (invariant 50).
fn is_transient(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock | io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset | io::ErrorKind::TimedOut)
}

/// Read a whole validated frame before decoding it (invariant 51).
fn read_frame(stream: &mut ControlStream) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; LENGTH_PREFIX];
    stream.read_exact(&mut prefix)?;
    let length = decode_length(prefix).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body)?;
    Ok(body)
}
fn write_bytes(stream: &mut ControlStream, frame: &[u8]) -> io::Result<()> {
    stream.write_all(frame)?;
    stream.flush()
}

fn write_frame<T: serde::Serialize>(stream: &mut ControlStream, message: &T) -> io::Result<()> {
    let frame = encode(message).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_bytes(stream, &frame)
}

fn handle_connection<P: EnginePeer>(
    mut stream: ControlStream,
    peer: Arc<Mutex<P>>,
    secret: Option<String>,
) -> io::Result<()> {
    let mut inbound = SequenceTracker::new();
    let outbound = AtomicU64::new(0);
    // The server retains the encoded acknowledgement for every admitted
    // request. Sequence handling happens first; only then can a retransmission
    // receive its original reply without re-executing its intent (invariant 33).
    let mut acknowledgements = HashMap::<Sequence, Vec<u8>>::new();
    let mut authentication = secret.is_none().then_some(ConnectionAuthorization::Unprotected);

    loop {
        let body = match read_frame(&mut stream) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        };
        let envelope: Envelope<ClientRequest> = decode_body(&body).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        match inbound.admit(envelope.seq) {
            Admission::Accepted => {}
            // A duplicate must receive the acknowledgement it lost, while its
            // intent must not run twice (invariant 49).
            Admission::Duplicate => {
                let acknowledgement = acknowledgements.get(&envelope.seq).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "duplicate has no recorded acknowledgement")
                })?;
                write_bytes(&mut stream, acknowledgement)?;
                continue;
            }
            Admission::Gap { expected, got } => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("sequence gap: expected {}, got {}", expected.0, got.0))),
        }

        let (reply, events) = match envelope.payload {
            ClientRequest::Authenticate { token: presented } => {
                let verified = secret.as_deref().map_or(Ok(ConnectionAuthorization::Unprotected), |secret| {
                    Token::parse(presented).and_then(|token| token.verify(secret)).map(ConnectionAuthorization::Authenticated)
                });
                match verified {
                    Ok(authorization) => { authentication = Some(authorization); (EngineReply::Authenticated, Vec::new()) }
                    Err(_) => (EngineReply::Refused(Refusal::Unauthenticated), Vec::new()),
                }
            }
            request if authentication.is_none() => { let _ = request; (EngineReply::Refused(Refusal::Unauthenticated), Vec::new()) }
            request => {
                // The engine is held only to validate and to drain events. A
                // render's work runs after the lock is released, so Program's
                // render loop is never queued behind it (invariant 14).
                let mut engine = peer.lock().expect("engine mutex poisoned");
                let handled = engine.handle_detached(request);
                let events = engine.drain_events();
                drop(engine);
                (handled.finish(), events)
            }
        };

        let next = || Sequence(outbound.fetch_add(1, Ordering::Relaxed) + 1);
        let reply_envelope = Envelope::new(MessageId(format!("reply.{}", envelope.id.0)), next(), reply);
        let reply_frame = encode(&reply_envelope)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        acknowledgements.insert(envelope.seq, reply_frame.clone());
        write_bytes(&mut stream, &reply_frame)?;
        for (index, event) in events.into_iter().enumerate() {
            let event_envelope = Envelope::new(MessageId(format!("event.{index}")), next(), event);
            write_frame(&mut stream, &event_envelope)?;
        }
    }
}
