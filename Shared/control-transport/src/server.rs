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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use gx_contracts::Refusal;
use gx_control_plane::bind::{
    bind_endpoint, BindRefusal, ControlListener, ControlStream, Endpoint,
};
use gx_control_plane::framing::{
    decode_body, decode_length, encode, LENGTH_PREFIX, MAX_FRAME_BYTES,
};
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
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}
impl std::error::Error for ServeError {}

/// What a control listener holds every connection to (2.22). A stalled or hostile
/// peer costs the engine a bounded thread for a bounded time. None of these
/// bounds touches a connection that has authenticated and is merely quiet: the
/// shells keep one open for the life of the window, and the protocol has no
/// ping, so an idle limit would drop a legitimate client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerLimits {
    /// Connections held at once. One more is closed at once and logged.
    pub max_connections: usize,
    /// From accept to the first request (an unprotected listener) or to the
    /// request that authenticates (a protected one).
    pub first_frame_deadline: Duration,
    /// Once a frame has begun, the time it has to arrive whole.
    pub frame_deadline: Duration,
    /// How long one write may wait for a peer that does not read.
    pub write_deadline: Duration,
    /// The largest frame a peer that has not authenticated may send. A larger
    /// declared length is refused before any buffer is allocated.
    pub preauth_frame_bytes: usize,
    /// How many of the latest acknowledgements a connection keeps, for a
    /// duplicate sequence number (invariant 33). An older one cannot be repeated.
    pub ack_window: u64,
}

impl Default for ServerLimits {
    fn default() -> Self {
        Self {
            max_connections: 32,
            first_frame_deadline: Duration::from_secs(10),
            frame_deadline: Duration::from_secs(10),
            write_deadline: Duration::from_secs(10),
            preauth_frame_bytes: 4 * 1024,
            ack_window: 64,
        }
    }
}

/// A place in the connection count, given back when the connection ends.
struct Permit(Arc<AtomicUsize>);

impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Take a place if fewer than `max` are held.
fn take_permit(held: &Arc<AtomicUsize>, max: usize) -> Option<Permit> {
    let mut now = held.load(Ordering::SeqCst);
    loop {
        if now >= max {
            return None;
        }
        match held.compare_exchange(now, now + 1, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return Some(Permit(Arc::clone(held))),
            Err(seen) => now = seen,
        }
    }
}

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
    /// What every connection is held to (2.22).
    limits: ServerLimits,
    /// Connections held now, against `limits.max_connections`.
    connections: Arc<AtomicUsize>,
}

/// What a connection has proved. A protected connection's claims are checked
/// against every request before the engine sees it (5.7): the control port is
/// Playout's, and each Program change needs its own scope
/// (`ClientRequest::authorise`). An unprotected connection exists only on an
/// L0 endpoint the bind policy approved without a secret.
enum ConnectionAuthorization {
    Unprotected,
    Authenticated(Claims),
}

impl ConnectionAuthorization {
    fn authorise(&self, request: &ClientRequest) -> Result<(), Refusal> {
        match self {
            Self::Unprotected => Ok(()),
            Self::Authenticated(claims) => request.authorise(claims.role, &claims.scopes),
        }
    }
}

impl<P: EnginePeer + Send + 'static> Server<P> {
    /// Bind TCP after policy approval. This keeps every existing caller source
    /// compatible; choose [`Self::bind_local`] for the OS local transport.
    pub fn bind(addr: SocketAddr, secret: Option<&str>, peer: P) -> Result<Self, ServeError> {
        Self::bind_endpoint(Endpoint::Tcp(addr), secret, peer)
    }

    /// Bind named-pipe IPC on Windows or a Unix-domain socket on Unix.
    pub fn bind_local(
        path: impl AsRef<Path>,
        secret: Option<&str>,
        peer: P,
    ) -> Result<Self, ServeError> {
        Self::bind_endpoint(Endpoint::Local(path.as_ref().to_path_buf()), secret, peer)
    }

    /// Bind a caller-selected endpoint through the one control-plane policy.
    pub fn bind_endpoint(
        endpoint: Endpoint,
        secret: Option<&str>,
        peer: P,
    ) -> Result<Self, ServeError> {
        let listener = bind_endpoint(&endpoint, secret).map_err(ServeError::Refused)?;
        Ok(Self {
            listener,
            endpoint,
            peer: Arc::new(Mutex::new(peer)),
            secret: secret.map(str::to_owned),
            limits: ServerLimits::default(),
            connections: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Hold every connection to `limits` instead of the defaults.
    #[must_use]
    pub fn with_limits(mut self, limits: ServerLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn engine(&self) -> Arc<Mutex<P>> {
        Arc::clone(&self.peer)
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    pub fn limits(&self) -> ServerLimits {
        self.limits
    }

    /// The TCP address actually bound. Local endpoints have no port and name
    /// that mismatch instead of inventing one for compatibility.
    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        match &self.listener {
            ControlListener::Tcp(listener) => listener.local_addr(),
            #[cfg(any(windows, unix))]
            ControlListener::Local(_) => Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "a local control endpoint has no TCP address",
            )),
        }
    }

    /// Accept forever, one thread per connection. The sequencing path below is
    /// shared for TCP and local streams, so locality cannot change delivery
    /// semantics (invariant 13).
    pub fn serve(self) {
        loop {
            match self.listener.accept() {
                Ok(stream) => {
                    // 2.22: a connection over the cap is closed at once, and the
                    // listener keeps accepting. The place is given back when the
                    // connection's thread ends.
                    let Some(permit) = take_permit(&self.connections, self.limits.max_connections)
                    else {
                        tracing::warn!(
                            event = "control.connection_refused",
                            peer = peer_name(&stream).as_str(),
                            cap = self.limits.max_connections,
                            reason = "the listener is holding its most connections",
                        );
                        continue;
                    };
                    let peer = Arc::clone(&self.peer);
                    let secret = self.secret.clone();
                    let limits = self.limits;
                    thread::spawn(move || {
                        let _permit = permit;
                        serve_connection(stream, peer, secret, limits);
                    });
                }
                Err(error) if is_transient(&error) => {
                    eprintln!("accept failed, continuing: {error}");
                    tracing::warn!(event = "control.accept_failed", detail = %error);
                }
                Err(error) => {
                    eprintln!("listener stopping: {error}");
                    tracing::error!(event = "control.listener_stopped", detail = %error);
                    return;
                }
            }
        }
    }

    pub fn serve_in_background(self) -> JoinHandle<()> {
        thread::spawn(move || self.serve())
    }
}

/// A failed accept may be retried only if one connection attempt failed; a
/// persistent listener failure must stop rather than consume a core (invariant 50).
fn is_transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::TimedOut
    )
}

/// The shortest read deadline set: a zero timeout is an error to the system.
const SHORTEST_DEADLINE: Duration = Duration::from_millis(1);

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    )
}

/// Read until `buffer` is full, all of it within `deadline` of `started`.
fn read_exact_by(
    stream: &mut ControlStream,
    buffer: &mut [u8],
    started: Instant,
    deadline: Duration,
) -> io::Result<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        let left = deadline
            .checked_sub(started.elapsed())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("a frame that had begun did not arrive within {deadline:?}"),
                )
            })?;
        stream.set_read_deadline(Some(left.max(SHORTEST_DEADLINE)))?;
        match stream.read(&mut buffer[filled..]) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if is_timeout(&error) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("a frame that had begun did not arrive within {deadline:?}"),
                ))
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// Read a whole validated frame before decoding it (invariant 51), under the
/// deadlines of 2.22. `first` bounds the wait for the frame's first byte (`None`
/// waits for ever: an authenticated peer may be quiet). Once a byte is in, the rest
/// of the frame has `frame` to arrive. A declared length over `max_bytes` is
/// refused before a buffer is allocated for it.
fn read_frame_within(
    stream: &mut ControlStream,
    first: Option<Duration>,
    frame: Duration,
    max_bytes: usize,
) -> io::Result<Vec<u8>> {
    stream.set_read_deadline(first.map(|wait| wait.max(SHORTEST_DEADLINE)))?;
    let mut one = [0u8; 1];
    loop {
        match stream.read(&mut one) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if is_timeout(&error) => {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "no request arrived within {:?} of the connection",
                        first.unwrap_or_default()
                    ),
                ))
            }
            Err(error) => return Err(error),
        }
    }
    let started = Instant::now();
    let mut prefix = [0u8; LENGTH_PREFIX];
    prefix[0] = one[0];
    read_exact_by(stream, &mut prefix[1..], started, frame)?;
    let length =
        decode_length(prefix).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if length > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a frame of {length} bytes where {max_bytes} is the most this peer may send"),
        ));
    }
    let mut body = vec![0u8; length];
    read_exact_by(stream, &mut body, started, frame)?;
    Ok(body)
}

/// Apply the per-stream limits to an accepted stream. Returns what could not be
/// applied, by name: a limit that is not in force is never silently claimed.
fn configure_stream(stream: &ControlStream, limits: &ServerLimits) -> Vec<String> {
    let mut problems = Vec::new();
    if let Err(error) = stream.set_low_latency() {
        problems.push(format!("low latency: {error}"));
    }
    match stream.set_write_deadline(Some(limits.write_deadline)) {
        Ok(true) => {}
        Ok(false) => problems.push("a write on this kind of stream has no deadline".to_owned()),
        Err(error) => problems.push(format!("write deadline: {error}")),
    }
    problems
}
fn write_bytes(stream: &mut ControlStream, frame: &[u8]) -> io::Result<()> {
    stream.write_all(frame)?;
    stream.flush()
}

fn write_frame<T: serde::Serialize>(stream: &mut ControlStream, message: &T) -> io::Result<()> {
    let frame =
        encode(message).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    write_bytes(stream, &frame)
}

/// Who is on the other end, for the log: a TCP address, or `local` for a
/// named pipe or a Unix-domain socket, which have none.
fn peer_name(stream: &ControlStream) -> String {
    match stream {
        ControlStream::Tcp(tcp) => tcp
            .peer_addr()
            .map_or_else(|_| "tcp".to_owned(), |address| address.to_string()),
        #[cfg(any(windows, unix))]
        ControlStream::Local(_) => "local".to_owned(),
    }
}

/// Why a presented credential was refused, as a fixed word. Never the
/// error's own text: an unknown prefix quotes what was presented, and a
/// credential, even a wrong one, is never written to a log (invariant 54).
fn token_fault(error: &crate::TokenError) -> &'static str {
    match error {
        crate::TokenError::UnknownPrefix { .. } => "unknownPrefix",
        crate::TokenError::MalformedToken => "malformedToken",
        crate::TokenError::InvalidPayloadEncoding => "invalidPayloadEncoding",
        crate::TokenError::InvalidPayload => "invalidPayload",
        crate::TokenError::InvalidClaims(_) => "invalidClaims",
        crate::TokenError::WrongMacLength { .. } => "wrongMacLength",
        crate::TokenError::InvalidMacEncoding => "invalidMacEncoding",
        crate::TokenError::MacMismatch => "macMismatch",
    }
}

/// Serve one connection from accept to close, with both ends of its life on
/// record (2.12, ADR-0004): who connected, and when and why it ended.
fn serve_connection<P: EnginePeer>(
    stream: ControlStream,
    peer: Arc<Mutex<P>>,
    secret: Option<String>,
    limits: ServerLimits,
) {
    let from = peer_name(&stream);
    tracing::info!(
        event = "control.connected",
        peer = from.as_str(),
        protected = secret.is_some(),
    );
    for problem in configure_stream(&stream, &limits) {
        tracing::warn!(
            event = "control.limits_not_applied",
            peer = from.as_str(),
            detail = problem.as_str(),
        );
    }
    let mut requests = 0u64;
    match handle_connection(stream, peer, secret, limits, &mut requests) {
        Ok(()) => tracing::info!(
            event = "control.disconnected",
            peer = from.as_str(),
            requests,
            reason = "closed by the client",
        ),
        Err(error) => {
            eprintln!("control connection closed: {error}");
            tracing::warn!(
                event = "control.disconnected",
                peer = from.as_str(),
                requests,
                reason = %error,
            );
        }
    }
}

/// A request the transport answered itself, before the engine saw it: one
/// from a connection that has not proved who it is, or one outside the scopes
/// its credential grants (5.7). On record with who asked, never with a
/// credential.
fn log_refusal(
    request: &'static str,
    refusal: &Refusal,
    authentication: Option<&ConnectionAuthorization>,
) {
    let (subject, role) = match authentication {
        Some(ConnectionAuthorization::Authenticated(claims)) => (
            Some(claims.subject.as_str()),
            Some(format!("{:?}", claims.role)),
        ),
        _ => (None, None),
    };
    tracing::info!(
        event = "control.refused",
        request,
        refusal = refusal.code_name(),
        detail = %refusal,
        subject,
        role = role.as_deref(),
    );
}

/// 2.19: a stop request that passed the scope check and is handed to the engine.
/// Written before the engine sees it, under the request's correlation id, so the
/// engine's own `engine.stop` (which carries the same id) can be followed to who
/// asked: the credential's subject and role, never the credential.
fn log_stop_request(authentication: Option<&ConnectionAuthorization>) {
    let (subject, role) = match authentication {
        Some(ConnectionAuthorization::Authenticated(claims)) => (
            Some(claims.subject.as_str()),
            Some(format!("{:?}", claims.role)),
        ),
        _ => (None, None),
    };
    tracing::warn!(
        event = "control.stop_requested",
        subject,
        role = role.as_deref(),
    );
}

fn handle_connection<P: EnginePeer>(
    mut stream: ControlStream,
    peer: Arc<Mutex<P>>,
    secret: Option<String>,
    limits: ServerLimits,
    requests: &mut u64,
) -> io::Result<()> {
    let accepted = Instant::now();
    let mut inbound = SequenceTracker::new();
    let outbound = AtomicU64::new(0);
    // The server retains the encoded acknowledgement for every admitted
    // request. Sequence handling happens first; only then can a retransmission
    // receive its original reply without re-executing its intent (invariant 33).
    let mut acknowledgements = HashMap::<Sequence, Vec<u8>>::new();
    let mut authentication = secret
        .is_none()
        .then_some(ConnectionAuthorization::Unprotected);

    loop {
        // 2.22: until the peer has authenticated (or, on an unprotected listener,
        // has sent its first request) it has `first_frame_deadline` from accept,
        // and may send a small frame only. After that a quiet peer is left alone;
        // a frame that begins must arrive whole within `frame_deadline`.
        let awaiting_first = authentication.is_none() || *requests == 0;
        let first = awaiting_first.then(|| {
            limits
                .first_frame_deadline
                .saturating_sub(accepted.elapsed())
        });
        let max_bytes = if authentication.is_none() {
            limits.preauth_frame_bytes
        } else {
            MAX_FRAME_BYTES
        };
        let body = match read_frame_within(&mut stream, first, limits.frame_deadline, max_bytes) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error),
        };
        let envelope: Envelope<ClientRequest> = decode_body(&body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        // 2.13: everything this request causes, here and in the engine it
        // reaches, is written under the id it arrived with. An id that does not
        // pass the check is not entered and its text is not kept.
        let presented = envelope.id.correlation();
        let _correlation = presented
            .filter(|id| gx_telemetry::corr::is_valid(id))
            .map(gx_telemetry::corr::enter);
        if presented.is_some() && _correlation.is_none() {
            tracing::warn!(event = "corr.rejected", origin = "control");
        }
        match inbound.admit(envelope.seq) {
            Admission::Accepted => {}
            // A duplicate must receive the acknowledgement it lost, while its
            // intent must not run twice (invariant 49).
            Admission::Duplicate => {
                let acknowledgement = acknowledgements.get(&envelope.seq).ok_or_else(|| {
                    tracing::warn!(
                        event = "control.window_passed",
                        sequence = envelope.seq.0,
                        window = limits.ack_window,
                    );
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "retransmission window passed: sequence {} is older than the {} acknowledgements this connection keeps",
                            envelope.seq.0, limits.ack_window
                        ),
                    )
                })?;
                write_bytes(&mut stream, acknowledgement)?;
                continue;
            }
            Admission::Gap { expected, got } => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("sequence gap: expected {}, got {}", expected.0, got.0),
                ))
            }
        }

        *requests += 1;
        let (reply, events) = match envelope.payload {
            ClientRequest::Authenticate { token: presented } => {
                let verified =
                    secret
                        .as_deref()
                        .map_or(Ok(ConnectionAuthorization::Unprotected), |secret| {
                            Token::parse(presented)
                                .and_then(|token| token.verify(secret))
                                .map(ConnectionAuthorization::Authenticated)
                        });
                match verified {
                    Ok(authorization) => {
                        // Who this connection is from now on: the subject,
                        // role and scopes its credential proved, never the
                        // credential.
                        if let ConnectionAuthorization::Authenticated(claims) = &authorization {
                            tracing::info!(
                                event = "control.authenticated",
                                subject = claims.subject.as_str(),
                                role = ?claims.role,
                                scopes = ?claims.scopes,
                            );
                        }
                        authentication = Some(authorization);
                        (EngineReply::Authenticated, Vec::new())
                    }
                    Err(error) => {
                        tracing::info!(
                            event = "control.refused",
                            request = "authenticate",
                            refusal = Refusal::Unauthenticated.code_name(),
                            detail = token_fault(&error),
                        );
                        (EngineReply::Refused(Refusal::Unauthenticated), Vec::new())
                    }
                }
            }
            request if authentication.is_none() => {
                log_refusal(request.name(), &Refusal::Unauthenticated, None);
                (EngineReply::Refused(Refusal::Unauthenticated), Vec::new())
            }
            // 5.7: an out-of-scope request is answered here, so the engine is
            // never locked for it and its handler never runs.
            request
                if authentication
                    .as_ref()
                    .is_some_and(|granted| granted.authorise(&request).is_err()) =>
            {
                let refusal = authentication
                    .as_ref()
                    .map(|granted| granted.authorise(&request))
                    .and_then(Result::err)
                    .expect("the guard saw a refusal");
                log_refusal(request.name(), &refusal, authentication.as_ref());
                (EngineReply::Refused(refusal), Vec::new())
            }
            request => {
                if matches!(request, ClientRequest::Stop) {
                    log_stop_request(authentication.as_ref());
                }
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

        let stopping = matches!(reply, EngineReply::Stopping);
        let next = || Sequence(outbound.fetch_add(1, Ordering::Relaxed) + 1);
        let reply_envelope =
            Envelope::new(MessageId(format!("reply.{}", envelope.id.0)), next(), reply);
        let reply_frame = encode(&reply_envelope)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        acknowledgements.insert(envelope.seq, reply_frame.clone());
        // 2.22: only the latest `ack_window` are kept; the oldest is let go.
        if let Some(oldest) = envelope.seq.0.checked_sub(limits.ack_window) {
            acknowledgements.remove(&Sequence(oldest));
        }
        let written = write_bytes(&mut stream, &reply_frame);
        if stopping {
            // The engine is waiting to end its process: tell it whether the reply left.
            peer.lock()
                .expect("engine mutex poisoned")
                .stop_reply_delivered(written.is_ok());
        }
        written?;
        for (index, event) in events.into_iter().enumerate() {
            let event_envelope = Envelope::new(MessageId(format!("event.{index}")), next(), event);
            write_frame(&mut stream, &event_envelope)?;
        }
    }
}

/// Tests that run a server, or capture what one logs, take this one at a time.
///
/// `tracing` registers each event's call site once per process and caches
/// whether anyone is listening. A server test that runs beside the log-capture
/// test can register `control.disconnected` in the middle of the capture test's
/// dispatcher being set, and the capture then loses the event (it did, 16 runs of
/// 20, once the 2.22 limit tests were added). Serial tests cannot race.
#[cfg(test)]
static SERVER_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod log_tests {
    //! 2.12: what the transport answers itself is on record: who connected,
    //! who they proved to be, every request refused before the engine saw
    //! it, and how the connection ended. Never a credential.

    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use gx_contracts::auth::{Role, Scope};
    use gx_contracts::{ContentHash, RationalRate, Revision, TakeId};
    use gx_control_plane::intent::{TakeAt, TakeRequest};
    use gx_mock_engine::MockEngine;
    use tracing_subscriber::layer::SubscriberExt;

    use super::*;
    use crate::Client;

    const SECRET: &str = "transport-log-test-secret-0123456789";

    fn take() -> ClientRequest {
        ClientRequest::Take(TakeRequest {
            take_id: TakeId("t".into()),
            revision: Revision(1),
            content_hash: Some(ContentHash("a".repeat(64))),
            at: TakeAt::NextOpportunity,
        })
    }

    #[test]
    fn connections_credentials_and_refusals_are_on_record_without_a_credential() {
        let _alone = crate::server::SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut engine = MockEngine::new().genlocked(RationalRate::P29_97);
        engine.publish(TakeId("t".into()), Revision(1), ContentHash("a".repeat(64)));
        let server = Server::bind(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            Some(SECRET),
            engine,
        )
        .expect("bind loopback");
        let addr = server.local_addr().expect("local addr");

        let wrong = Token::mint(
            "intruder",
            Role::Playout,
            vec![Scope::Take],
            "another-secret-0123456789abcdef",
        )
        .expect("mint");
        let cue_only =
            Token::mint("cue-operator", Role::Playout, vec![Scope::Cue], SECRET).expect("mint");
        let (wrong_text, cue_text) = (wrong.as_str().to_owned(), cue_only.as_str().to_owned());

        // Four clients, one after another: no credential, a credential made
        // with another secret, a valid one that may cue but not take (its take
        // made inside a correlation scope, as a shell does), and a raw peer
        // that presents a request id whose correlation part is not valid.
        let clients = std::thread::spawn(move || {
            assert!(Client::connect(addr).is_err(), "no credential is refused");
            assert!(
                Client::connect_with_token(addr, wrong).is_err(),
                "a credential from another secret is refused"
            );
            let mut operator = Client::connect_with_token(addr, cue_only).expect("authenticated");
            let refused = {
                let _scope = gx_telemetry::corr::enter("po-take-7");
                operator.handle(take())
            };
            assert!(
                matches!(
                    refused,
                    EngineReply::Refused(Refusal::ScopeNotGranted { .. })
                ),
                "{refused:?}"
            );
            drop(operator);
            // A request id whose correlation part carries a dot and spaces: a
            // peer that is not one of ours, or a front end gone wrong.
            use std::io::{Read as _, Write as _};
            let mut raw = std::net::TcpStream::connect(addr).expect("connect");
            let hostile = Envelope::new(
                MessageId("req.1.not a valid.id".into()),
                Sequence(1),
                ClientRequest::capability(),
            );
            raw.write_all(&encode(&hostile).expect("encode"))
                .expect("write");
            let mut prefix = [0u8; LENGTH_PREFIX];
            raw.read_exact(&mut prefix).expect("a reply arrives");
            let mut body = vec![0u8; decode_length(prefix).expect("a length")];
            raw.read_exact(&mut body).expect("the reply body");
        });

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-transport-log-{}-{nanos}", std::process::id()));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("engine", "worker", &dir))
                .unwrap();
        // Served one connection after another on one thread, under this
        // test's own log: each client that goes away must end its connection
        // at the server, or the next is never accepted.
        let dispatch = tracing::Dispatch::new(tracing_subscriber::registry().with(guard.layer()));
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            tracing::dispatcher::with_default(&dispatch, || {
                for _ in 0..4 {
                    let stream = server.listener.accept().expect("accept");
                    serve_connection(
                        stream,
                        Arc::clone(&server.peer),
                        server.secret.clone(),
                        server.limits,
                    );
                }
            });
            let _ = done.send(());
        });
        clients.join().expect("the clients ran");
        finished
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("a client that went away did not end its connection at the server");
        guard.finish().unwrap();

        let mut text = String::new();
        let mut records: Vec<serde_json::Value> = Vec::new();
        for entry in std::fs::read_dir(dir.join("engine")).unwrap().flatten() {
            let file = std::fs::read_to_string(entry.path()).unwrap();
            records.extend(file.lines().map(|line| serde_json::from_str(line).unwrap()));
            text.push_str(&file);
        }
        let _ = std::fs::remove_dir_all(&dir);

        let of = |event: &str| -> Vec<&serde_json::Value> {
            records.iter().filter(|r| r["event"] == event).collect()
        };
        let connected = of("control.connected");
        assert_eq!(connected.len(), 4, "{records:#?}");
        assert!(connected.iter().all(|r| r["fields"]["protected"] == true));
        // Outside a scope, nothing carries an id.
        assert!(
            records
                .iter()
                .filter(
                    |r| r["event"] == "control.connected" || r["event"] == "control.authenticated"
                )
                .all(|r| r["corr"].is_null()),
            "{records:#?}"
        );
        assert!(connected[0]["fields"]["peer"]
            .as_str()
            .is_some_and(|peer| peer.starts_with("127.0.0.1:")));

        let refused = of("control.refused");
        // No credential: the capability exchange is refused, by name.
        assert!(
            refused
                .iter()
                .any(|r| r["fields"]["request"] == "capability"
                    && r["refusal"] == "unauthenticated"
                    && r["fields"]["subject"].is_null()),
            "{refused:#?}"
        );
        // A credential that does not verify: refused with the fault's name.
        assert!(
            refused
                .iter()
                .any(|r| r["fields"]["request"] == "authenticate"
                    && r["refusal"] == "unauthenticated"
                    && r["fields"]["detail"] == "macMismatch"),
            "{refused:#?}"
        );
        // A valid credential without the take scope: refused before the
        // engine, with who asked.
        let scope = refused
            .iter()
            .find(|r| r["fields"]["request"] == "take")
            .unwrap_or_else(|| panic!("no take refusal in {refused:#?}"));
        assert_eq!(scope["refusal"], "scopeNotGranted");
        // 2.13: the request was made inside a scope, so the refusal the
        // transport wrote for it carries that scope's id.
        assert_eq!(scope["corr"], "po-take-7", "{scope}");
        assert_eq!(scope["fields"]["subject"], "cue-operator");
        assert_eq!(scope["fields"]["role"], "Playout");

        let authenticated = of("control.authenticated");
        assert_eq!(authenticated.len(), 1, "only the credential that verified");
        assert_eq!(authenticated[0]["fields"]["subject"], "cue-operator");
        assert_eq!(authenticated[0]["fields"]["scopes"], "[Cue]");

        let closed = of("control.disconnected");
        assert_eq!(closed.len(), 4, "{records:#?}");
        // authenticate, capability, take: three requests on the operator's.
        assert_eq!(closed[2]["fields"]["requests"], 3);
        assert_eq!(closed[2]["fields"]["reason"], "closed by the client");

        // 2.13: an id that does not pass the check is rejected, by name and
        // without its text, and the request is answered without one.
        let rejected = of("corr.rejected");
        assert_eq!(rejected.len(), 1, "{records:#?}");
        assert_eq!(rejected[0]["fields"]["origin"], "control");
        assert!(!text.contains("not a valid"), "the rejected id was kept");
        let hostile = refused
            .iter()
            .find(|r| r["fields"]["request"] == "capability" && r["fields"]["subject"].is_null())
            .and_then(|r| r["corr"].as_null());
        assert!(hostile.is_some(), "a rejected id was entered: {refused:#?}");

        for secret in [SECRET, wrong_text.as_str(), cue_text.as_str()] {
            assert!(!text.contains(secret), "a credential reached the log");
        }
        // Not even a part of one: the MAC and the payload are both absent.
        let mac = cue_text.rsplit('.').next().unwrap();
        let payload = cue_text.split('.').nth(1).unwrap();
        assert!(!text.contains(mac) && !text.contains(payload));
    }
}

#[cfg(test)]
mod limits_tests {
    //! 2.22: a stalled or hostile peer costs the engine a bounded thread for a
    //! bounded time, shown over real sockets: one that sends nothing, one that
    //! starts a frame and stops, one that declares a large frame before it has
    //! authenticated, and one connection too many. A peer that has authenticated
    //! and is merely quiet is left alone.

    use std::io::{Read, Write};
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use gx_contracts::auth::{Role, Scope};
    use gx_control_plane::framing::encode;
    use gx_control_plane::message::{ClientRequest, EngineReply, Envelope};
    use gx_control_plane::peer::EnginePeer;
    use gx_control_plane::sequence::{MessageId, Sequence};
    use gx_mock_engine::MockEngine;

    use super::*;
    use crate::Client;

    const SECRET: &str = "transport-limits-secret-0123456789ab";

    fn quick() -> ServerLimits {
        ServerLimits {
            max_connections: 3,
            first_frame_deadline: Duration::from_millis(400),
            frame_deadline: Duration::from_millis(400),
            write_deadline: Duration::from_secs(2),
            preauth_frame_bytes: 256,
            ack_window: 4,
        }
    }

    fn serve_with<P: EnginePeer + Send + 'static>(
        secret: Option<&str>,
        limits: ServerLimits,
        peer: P,
    ) -> SocketAddr {
        let server = Server::bind(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            secret,
            peer,
        )
        .expect("bind loopback")
        .with_limits(limits);
        let addr = server.local_addr().expect("address");
        server.serve_in_background();
        addr
    }

    fn serve(secret: Option<&str>, limits: ServerLimits) -> SocketAddr {
        serve_with(secret, limits, MockEngine::new())
    }

    fn credential(scopes: Vec<Scope>) -> Token {
        Token::mint("limits-test", Role::Playout, scopes, SECRET).expect("a credential is minted")
    }

    /// How long until the server closes `stream`, or `None` if it is still open
    /// after `limit`. Anything it sends meanwhile is read and thrown away.
    fn closed_after(stream: &mut TcpStream, limit: Duration) -> Option<Duration> {
        let started = Instant::now();
        let mut sink = [0u8; 256];
        while started.elapsed() < limit {
            let left = limit
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(1));
            stream.set_read_timeout(Some(left)).expect("a read timeout");
            match stream.read(&mut sink) {
                Ok(0) => return Some(started.elapsed()),
                Ok(_) => {}
                Err(error) if is_timeout(&error) => return None,
                Err(_) => return Some(started.elapsed()),
            }
        }
        None
    }

    fn request_frame(seq: u64, request: ClientRequest) -> Vec<u8> {
        encode(&Envelope::new(
            MessageId(format!("req.{seq}")),
            Sequence(seq),
            request,
        ))
        .expect("a frame encodes")
    }

    /// One whole frame (prefix and body) from the server.
    fn read_frame_bytes(stream: &mut TcpStream) -> Vec<u8> {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("a read timeout");
        let mut prefix = [0u8; LENGTH_PREFIX];
        stream.read_exact(&mut prefix).expect("a reply prefix");
        let mut body = vec![0u8; u32::from_be_bytes(prefix) as usize];
        stream.read_exact(&mut body).expect("a reply body");
        [prefix.to_vec(), body].concat()
    }

    #[test]
    fn a_peer_that_sends_nothing_is_dropped_at_the_first_frame_deadline() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for (label, secret) in [("protected", Some(SECRET)), ("unprotected", None)] {
            let addr = serve(secret, quick());
            let mut silent = TcpStream::connect(addr).expect("connects");
            let took = closed_after(&mut silent, Duration::from_secs(5))
                .unwrap_or_else(|| panic!("{label}: a silent peer was still held after 5 s"));
            assert!(
                took >= Duration::from_millis(300) && took < Duration::from_secs(2),
                "{label}: dropped after {took:?}, deadline 400 ms"
            );
        }
    }

    #[test]
    fn a_peer_that_has_authenticated_may_be_quiet_for_longer_than_every_deadline() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let addr = serve(Some(SECRET), quick());
        let mut client = Client::connect_with_token(addr, credential(vec![Scope::Cue]))
            .expect("a credential for the secret connects");
        std::thread::sleep(Duration::from_millis(1500));
        let reply = client.request(ClientRequest::Status).expect("a reply");
        assert!(
            matches!(reply, EngineReply::Status(_)),
            "a quiet but authenticated peer was dropped: {reply:?}"
        );
    }

    #[test]
    fn a_frame_that_begins_and_stalls_is_dropped_at_the_frame_deadline() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let addr = serve(None, quick());
        let mut peer = TcpStream::connect(addr).expect("connects");
        // Get past the first request.
        peer.write_all(&request_frame(1, ClientRequest::capability()))
            .expect("a request is sent");
        let _ = read_frame_bytes(&mut peer);
        // Quiet, as a peer may be: still open well past every deadline.
        assert_eq!(
            closed_after(&mut peer, Duration::from_millis(1200)),
            None,
            "a peer that sent a request and is quiet must be left open"
        );
        // Begin a frame and stop.
        peer.write_all(&[0, 0]).expect("half a prefix is sent");
        let took = closed_after(&mut peer, Duration::from_secs(5))
            .expect("a frame that stalled was still held after 5 s");
        assert!(
            took >= Duration::from_millis(300) && took < Duration::from_secs(2),
            "dropped after {took:?}, frame deadline 400 ms"
        );
    }

    #[test]
    fn before_authentication_a_large_frame_is_refused_without_being_read() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut limits = quick();
        // Long enough that only the size can be what closes it.
        limits.first_frame_deadline = Duration::from_secs(8);
        limits.frame_deadline = Duration::from_secs(8);
        let addr = serve(Some(SECRET), limits);
        let mut peer = TcpStream::connect(addr).expect("connects");
        // The prefix declares 1000 bytes; the body never comes.
        peer.write_all(&1000u32.to_be_bytes())
            .expect("a prefix is sent");
        let took = closed_after(&mut peer, Duration::from_secs(5))
            .expect("the declared size was waited on instead of refused");
        assert!(took < Duration::from_secs(2), "refused after {took:?}");
    }

    #[test]
    fn a_connection_over_the_cap_is_closed_at_once_and_a_place_is_given_back() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut limits = quick();
        limits.max_connections = 2;
        limits.first_frame_deadline = Duration::from_secs(30);
        let addr = serve(Some(SECRET), limits);
        let token = || credential(vec![Scope::Cue]);
        let first = Client::connect_with_token(addr, token()).expect("the first connects");
        let _second = Client::connect_with_token(addr, token()).expect("the second connects");

        let mut third = TcpStream::connect(addr).expect("the socket opens");
        let took = closed_after(&mut third, Duration::from_secs(3))
            .expect("a connection over the cap was held");
        assert!(
            took < Duration::from_secs(1),
            "closed after {took:?}, not at once"
        );

        // One of the two goes away: its place is given back.
        drop(first);
        let started = Instant::now();
        let mut again = None;
        while started.elapsed() < Duration::from_secs(5) {
            match Client::connect_with_token(addr, token()) {
                Ok(client) => {
                    again = Some(client);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
        assert!(again.is_some(), "a place was never given back");
    }

    #[test]
    fn only_the_latest_acknowledgements_are_kept_for_a_duplicate() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let addr = serve(None, quick());
        let mut peer = TcpStream::connect(addr).expect("connects");
        let mut replies = Vec::new();
        for seq in 1..=6u64 {
            peer.write_all(&request_frame(seq, ClientRequest::capability()))
                .expect("a request is sent");
            replies.push(read_frame_bytes(&mut peer));
        }
        // The window is 4: 3, 4, 5 and 6 are kept; 1 and 2 are let go.
        peer.write_all(&request_frame(6, ClientRequest::capability()))
            .expect("a duplicate is sent");
        assert_eq!(
            read_frame_bytes(&mut peer),
            replies[5],
            "the latest is repeated"
        );
        peer.write_all(&request_frame(3, ClientRequest::capability()))
            .expect("a duplicate is sent");
        assert_eq!(
            read_frame_bytes(&mut peer),
            replies[2],
            "the oldest kept one is repeated"
        );
        peer.write_all(&request_frame(2, ClientRequest::capability()))
            .expect("a duplicate is sent");
        let took = closed_after(&mut peer, Duration::from_secs(3))
            .expect("a duplicate older than the window was answered or held");
        assert!(took < Duration::from_secs(2), "closed after {took:?}");
    }

    #[test]
    fn an_accepted_stream_is_low_latency_and_its_writes_are_bounded() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("a listener");
        let addr = listener.local_addr().expect("an address");
        let _client = TcpStream::connect(addr).expect("connects");
        let (accepted, _) = listener.accept().expect("accepts");
        let stream = ControlStream::Tcp(accepted);
        let problems = configure_stream(&stream, &quick());
        assert!(problems.is_empty(), "{problems:?}");
        let ControlStream::Tcp(accepted) = &stream else {
            unreachable!("a TCP stream was wrapped");
        };
        assert!(
            accepted.nodelay().expect("nodelay reads"),
            "Nagle is still on"
        );
        assert_eq!(
            accepted.write_timeout().expect("a write timeout reads"),
            Some(Duration::from_secs(2))
        );
    }

    /// A peer that owns a process to end, and records what the transport tells it.
    struct Stopper {
        inner: MockEngine,
        told: Arc<Mutex<Vec<bool>>>,
    }

    impl EnginePeer for Stopper {
        fn capability(&self) -> gx_control_plane::capability::EngineCapability {
            self.inner.capability()
        }
        fn handle(&mut self, request: ClientRequest) -> EngineReply {
            match request {
                ClientRequest::Stop => EngineReply::Stopping,
                other => self.inner.handle(other),
            }
        }
        fn drain_events(&mut self) -> Vec<gx_control_plane::message::EngineEvent> {
            self.inner.drain_events()
        }
        fn stop_reply_delivered(&mut self, delivered: bool) {
            self.told.lock().expect("lock").push(delivered);
        }
    }

    #[test]
    fn the_transport_tells_the_engine_once_the_stop_reply_has_been_written() {
        let _alone = SERVER_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let told = Arc::new(Mutex::new(Vec::new()));
        let addr = serve_with(
            Some(SECRET),
            quick(),
            Stopper {
                inner: MockEngine::new(),
                told: Arc::clone(&told),
            },
        );
        let mut client = Client::connect_with_token(addr, credential(vec![Scope::Stop]))
            .expect("a credential for the secret connects");
        assert!(told.lock().expect("lock").is_empty(), "nothing yet");
        let reply = client.request(ClientRequest::Stop).expect("a reply");
        assert_eq!(reply, EngineReply::Stopping);
        let started = Instant::now();
        while told.lock().expect("lock").is_empty() && started.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            *told.lock().expect("lock"),
            vec![true],
            "told once, delivered"
        );
        // A request that is not a stop is not reported on.
        let _ = client.request(ClientRequest::Status).expect("a reply");
        assert_eq!(told.lock().expect("lock").len(), 1);
    }
}
