//! The control-plane listener.
//!
//! Generic over `EnginePeer`, so the same server carries a mock today and the
//! real worker later without either of them knowing about a socket.
//!
//! Three behaviours here come straight from the plane's guarantees:
//!
//! - **A gap closes the connection.** The control plane tolerates no loss
//!   (ADR-001), so there is no correct way to carry on past a missing message.
//!   ADR B.4 says reconnect and reconcile, and that is what closing forces.
//! - **A duplicate is acknowledged, not re-executed.** Re-applying a take
//!   because its request arrived twice would put a scene to air twice.
//! - **Replies carry a `reply.` id, events do not.** That is how the client
//!   tells them apart, and why they can never be confused for one another
//!   (invariant 33).

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use gx_contracts::Refusal;
use gx_control_plane::auth::Token;
use gx_control_plane::bind::{bind_listener, BindRefusal};
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::sequence::{Admission, MessageId, Sequence, SequenceTracker};

/// Why a server could not start.
#[derive(Debug)]
pub enum ServeError {
    /// The bind policy refused this address (invariant 41).
    Refused(BindRefusal),
    Io(io::Error),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::Refused(r) => write!(f, "{r}"),
            ServeError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ServeError {}

/// A control-plane server bound to an address, not yet accepting.
pub struct Server<P: EnginePeer> {
    listener: TcpListener,
    /// One engine, many clients. The mutex is the engine's serialisation
    /// point: requests are handled one at a time, in arrival order, which is
    /// what an ordered plane promises.
    peer: Arc<Mutex<P>>,
    /// The credential a connection must present, if any.
    ///
    /// `None` is only reachable on loopback: `check_bind` refuses a wider
    /// address without a token, and this field is what makes that refusal mean
    /// something on an accepted connection.
    token: Option<Token>,
}

impl<P: EnginePeer + Send + 'static> Server<P> {
    /// Bind, after checking the address against the bind policy.
    ///
    /// The bind goes through `gx_control_plane::bind::bind_listener`, the one
    /// place a control-plane socket is opened, so the policy check and the
    /// socket options are shared with every engine rather than re-decided here.
    pub fn bind(addr: SocketAddr, token: Option<&str>, peer: P) -> Result<Self, ServeError> {
        let listener = bind_listener(addr, token).map_err(ServeError::Refused)?;
        Ok(Self {
            listener,
            peer: Arc::new(Mutex::new(peer)),
            token: token.map(|t| Token(t.to_string())),
        })
    }

    /// A handle to the engine this server carries.
    ///
    /// The supervising host needs this to observe and restart the engine it
    /// owns; tests use it to drive the engine behind a live connection. It is
    /// the same `Arc` the connections hold, so a change through it is visible
    /// to every client immediately.
    pub fn engine(&self) -> Arc<Mutex<P>> {
        Arc::clone(&self.peer)
    }

    /// The address actually bound, which matters when port 0 was requested.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept forever, one thread per connection.
    ///
    /// Threads rather than an async runtime: the control plane carries a
    /// handful of long-lived connections, and ADR Part C does not pick an
    /// async runtime until QUIC arrives at L1. Choosing one now would be
    /// deciding L1's transport by accident.
    pub fn serve(self) {
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => {
                    let peer = Arc::clone(&self.peer);
                    let token = self.token.clone();
                    thread::spawn(move || {
                        if let Err(e) = handle_connection(stream, peer, token) {
                            eprintln!("control connection closed: {e}");
                        }
                    });
                }
                // One failed handshake must not take the listener down, but a
                // *persistent* failure must not be retried forever either.
                // Looping on an unrecoverable error burns a core and floods
                // the log with the same line, which is how a small fault
                // becomes the visible outage.
                Err(e) if is_transient(&e) => {
                    eprintln!("accept failed, continuing: {e}");
                }
                Err(e) => {
                    eprintln!("listener stopping: {e}");
                    return;
                }
            }
        }
    }

    /// Serve on a background thread. Used by tests and by the conformance
    /// runner, which needs a live server in the same process as its client.
    pub fn serve_in_background(self) -> JoinHandle<()> {
        thread::spawn(move || self.serve())
    }
}

/// Whether a failed accept is worth retrying.
///
/// Transient means "this connection attempt failed": the peer went away mid
/// handshake, or a signal interrupted the call. Anything else — the socket
/// layer being torn down, the listener being invalidated — will fail
/// identically on every subsequent call, so retrying is a spin, not
/// resilience.
fn is_transient(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::TimedOut
    )
}

/// Read a whole frame, or return an error explaining why not.
fn read_frame(stream: &mut TcpStream) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; LENGTH_PREFIX];
    stream.read_exact(&mut prefix)?;
    let len = decode_length(prefix).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    // Allocating only after the length has been checked against the plane's
    // limit: a peer cannot make this side reserve memory by lying.
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(body)
}

fn write_frame<T: serde::Serialize>(stream: &mut TcpStream, message: &T) -> io::Result<()> {
    let frame = encode(message).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    stream.write_all(&frame)?;
    stream.flush()
}

fn handle_connection<P: EnginePeer>(
    mut stream: TcpStream,
    peer: Arc<Mutex<P>>,
    token: Option<Token>,
) -> io::Result<()> {
    let mut inbound = SequenceTracker::new();
    let outbound = AtomicU64::new(0);
    // A fresh connection is unauthenticated. Reconnecting therefore
    // re-authenticates, which is what makes a leaked-then-rotated token
    // actually stop working.
    let mut authenticated = token.is_none();

    loop {
        let body = match read_frame(&mut stream) {
            Ok(body) => body,
            // An orderly close is not an error.
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };

        let envelope: Envelope<ClientRequest> =
            decode_body(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        match inbound.admit(envelope.seq) {
            Admission::Accepted => {}
            // Already processed. Do not run it again: a repeated take would
            // reach air twice.
            Admission::Duplicate => continue,
            // The plane tolerates no loss, so there is nothing sensible to do
            // but close and let the client reconnect and reconcile.
            Admission::Gap { expected, got } => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("sequence gap: expected {}, got {}", expected.0, got.0),
                ));
            }
        }

        // Authentication is handled here rather than by the engine: it is a
        // property of the connection, and an engine that had to check it on
        // every request would eventually forget on one of them.
        let (reply, events) = match envelope.payload {
            ClientRequest::Authenticate { token: presented } => {
                let ok = token
                    .as_ref()
                    .map(|expected| presented.verify(expected))
                    .unwrap_or(true);
                if ok {
                    authenticated = true;
                    (EngineReply::Authenticated, Vec::new())
                } else {
                    // Do not close: a client that mistyped a token should get
                    // a named refusal, and an attacker gains nothing from the
                    // connection staying open that it would not gain by
                    // redialling.
                    (EngineReply::Refused(Refusal::Unauthenticated), Vec::new())
                }
            }
            request if !authenticated => {
                // Every request, including capability, is refused until the
                // connection is authenticated. Answering capability first
                // would hand an unauthenticated caller the engine's tier,
                // clock and reference state.
                let _ = request;
                (EngineReply::Refused(Refusal::Unauthenticated), Vec::new())
            }
            request => {
                let mut engine = peer.lock().expect("engine mutex poisoned");
                let reply = engine.handle(request);
                (reply, engine.drain_events())
            }
        };

        let next = || Sequence(outbound.fetch_add(1, Ordering::Relaxed) + 1);

        // The reply, tagged so the client knows it is one.
        let reply_envelope =
            Envelope::new(MessageId(format!("reply.{}", envelope.id.0)), next(), reply);
        write_frame(&mut stream, &reply_envelope)?;

        // Events, tagged so they can never be mistaken for a reply.
        for (n, event) in events.into_iter().enumerate() {
            let event_envelope: Envelope<EngineEvent> =
                Envelope::new(MessageId(format!("event.{n}")), next(), event);
            write_frame(&mut stream, &event_envelope)?;
        }
    }
}
