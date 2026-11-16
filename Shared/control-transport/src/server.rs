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
use gx_control_plane::bind::{
    bind_endpoint, BindRefusal, ControlListener, ControlStream, Endpoint,
};
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
        match self {
            Self::Refused(refusal) => write!(f, "{refusal}"),
            Self::Io(error) => write!(f, "{error}"),
        }
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
        })
    }

    pub fn engine(&self) -> Arc<Mutex<P>> {
        Arc::clone(&self.peer)
    }
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
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
                    let peer = Arc::clone(&self.peer);
                    let secret = self.secret.clone();
                    thread::spawn(move || serve_connection(stream, peer, secret));
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

/// Read a whole validated frame before decoding it (invariant 51).
fn read_frame(stream: &mut ControlStream) -> io::Result<Vec<u8>> {
    let mut prefix = [0u8; LENGTH_PREFIX];
    stream.read_exact(&mut prefix)?;
    let length =
        decode_length(prefix).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body)?;
    Ok(body)
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
) {
    let from = peer_name(&stream);
    tracing::info!(
        event = "control.connected",
        peer = from.as_str(),
        protected = secret.is_some(),
    );
    let mut requests = 0u64;
    match handle_connection(stream, peer, secret, &mut requests) {
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

fn handle_connection<P: EnginePeer>(
    mut stream: ControlStream,
    peer: Arc<Mutex<P>>,
    secret: Option<String>,
    requests: &mut u64,
) -> io::Result<()> {
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
        let body = match read_frame(&mut stream) {
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
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "duplicate has no recorded acknowledgement",
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
        let reply_envelope =
            Envelope::new(MessageId(format!("reply.{}", envelope.id.0)), next(), reply);
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
                ClientRequest::Capability,
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
                    serve_connection(stream, Arc::clone(&server.peer), server.secret.clone());
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
