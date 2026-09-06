//! WebSocket transport.
//!
//! Accepts client connections, authenticates them, enforces the per-connection
//! reliability and security rules, dispatches to the [`Engine`], and streams
//! engine-initiated events back.
//!
//! Per connection, in this order — the order matters:
//!
//! 1. **Size limit**, before parsing, so an unbounded frame is never allocated.
//! 2. **Rate limit**, so a client looping on previews cannot starve the renderer.
//! 3. **Authentication**, so only the handshake works before a token is presented.
//! 4. **Sequence ordering**, so `Take` can never be applied before its `Cue`.
//! 5. **Duplicate suppression**, so a retransmit is acknowledged and not re-applied.
//!
//! Ordering before deduplication is deliberate. A retransmit reuses its `messageId`
//! but carries a fresh sequence number, so if dedupe ran first that sequence would
//! never be consumed and the connection would wedge on the first retransmission.
//!
//! A client disconnecting never disturbs Program. Program state lives in the
//! engine, not in a connection, which is the whole point of the separation.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::capabilities::ConnectionPrincipal;
use crate::config::EngineConfig;
use crate::engine::Engine;
use crate::protocol::{self, now_ms, Envelope, ErrorCode, ProtocolError, RequestType};
use crate::security::{
    MessageDeduplicator, RateLimiter, SequenceTracker, SequenceVerdict,
};

/// Subprotocol the client must offer, so a stray browser tab cannot connect.
const ENGINE_SUBPROTOCOL: &str = "grapix-engine-v3";
const BEARER_PREFIX: &str = "bearer.";

struct HandshakeSecurity {
    /// HMAC key for verifying access tokens. `None` leaves the engine unable to verify any
    /// token, which is only tenable on a development engine that requires none.
    signing_key: Option<Vec<u8>>,
    auth_required: bool,
    allowed_origins: HashSet<String>,
    client_allowlist: HashSet<String>,
}

/// What the handshake proved about a connection, and therefore the authority it carries.
///
/// Authority is credential-derived. A production engine (`auth.required`) recognises exactly
/// one credential - a valid access token - and issues no authority without it, from any
/// address including this machine's own. The unauthenticated shape exists only for a
/// development engine that has been deliberately configured without authentication.
#[derive(Debug, Clone, PartialEq, Eq)]
enum HandshakeGrant {
    /// A verified access token: authority is whatever the token's user carries.
    Identified(Box<crate::auth::VerifiedIdentity>),
    /// No credential, on a development engine that requires none. Editor authority, no user.
    AnonymousLocalEditor,
}

/// Whether a `host:port` peer string names this machine.
fn is_loopback_peer(peer: &str) -> bool {
    let host = match peer.rsplit_once(':') {
        Some((host, _)) => host,
        None => peer,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

#[derive(Debug, PartialEq, Eq)]
enum HandshakeRejection {
    OriginForbidden,
    ClientNotAllowlisted,
    SubprotocolMissing,
    AuthenticationFailed,
}

impl HandshakeRejection {
    fn status(&self) -> StatusCode {
        match self {
            HandshakeRejection::OriginForbidden | HandshakeRejection::ClientNotAllowlisted => {
                StatusCode::FORBIDDEN
            }
            HandshakeRejection::SubprotocolMissing => StatusCode::BAD_REQUEST,
            HandshakeRejection::AuthenticationFailed => StatusCode::UNAUTHORIZED,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            HandshakeRejection::OriginForbidden => "WebSocket Origin is not allowed",
            HandshakeRejection::ClientNotAllowlisted => "client address is not allowlisted",
            HandshakeRejection::SubprotocolMissing => {
                "client must offer the grapix-engine-v3 subprotocol"
            }
            HandshakeRejection::AuthenticationFailed => "render engine authentication failed",
        }
    }
}

pub async fn serve(config: EngineConfig, engine: Arc<Mutex<Engine>>) -> anyhow::Result<()> {
    let address = format!(
        "{}:{}",
        config.network.bind_address, config.network.websocket_port
    );

    let signing_key = config
        .resolve_signing_key()
        .context("failed to resolve the engine token signing secret")?;

    let security = Arc::new(HandshakeSecurity {
        signing_key,
        auth_required: config.auth.required,
        allowed_origins: config.network.allowed_origins.iter().cloned().collect(),
        client_allowlist: config.network.client_allowlist.iter().cloned().collect(),
    });

    let listener = TcpListener::bind(&address)
        .await
        .with_context(|| format!("failed to bind the engine WebSocket server on {address}"))?;

    let scheme = if config.network.is_remote_reachable() {
        "reachable from the network"
    } else {
        "loopback only"
    };
    tracing::info!(
        %address,
        auth_required = security.auth_required,
        "engine listening on ws://{address} ({scheme})"
    );

    let max_connections = config.security.max_connections as usize;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        let current = { engine.lock().await.connected_clients };
                        if current >= max_connections {
                            tracing::warn!(%peer, current, max_connections, "refusing connection: at the configured limit");
                            drop(stream);
                            continue;
                        }

                        let engine = Arc::clone(&engine);
                        let security = Arc::clone(&security);
                        let config = config.clone();
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, engine, security, config).await {
                                tracing::debug!(%peer, %error, "connection ended");
                            }
                        });
                    }
                    Err(error) => tracing::warn!(%error, "failed to accept a connection"),
                }
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutdown signal received; the engine is stopping");
                return Ok(());
            }
        }
    }
}

async fn handle_connection(
    stream: TcpStream,
    engine: Arc<Mutex<Engine>>,
    security: Arc<HandshakeSecurity>,
    config: EngineConfig,
) -> anyhow::Result<()> {
    let peer = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    // The WebSocket handshake is the authentication boundary, and it is what decides the
    // authority: a verified access token names a user and the permissions they carry. Hello
    // may report a client role for diagnostics, but it can never alter this principal.
    //
    // The grant has to cross a closure boundary because tungstenite validates the request
    // inside a callback, so it is parked in a mutex the callback fills and the connection
    // reads once the socket is accepted.
    let grant_cell: Arc<std::sync::Mutex<Option<HandshakeGrant>>> =
        Arc::new(std::sync::Mutex::new(None));
    let handshake_security = Arc::clone(&security);
    let peer_for_callback = peer.clone();
    let grant_slot = Arc::clone(&grant_cell);

    let callback =
        move |request: &Request, mut response: Response| -> Result<Response, ErrorResponse> {
            match validate_handshake(request, &handshake_security, &peer_for_callback) {
                Ok(grant) => {
                    if let Ok(mut slot) = grant_slot.lock() {
                        *slot = Some(grant);
                    }
                    // Echo the subprotocol, which tungstenite requires for the client
                    // to accept the connection.
                    response.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        ENGINE_SUBPROTOCOL.parse().expect("static header value"),
                    );
                    Ok(response)
                }
                Err(rejection) => Err(handshake_error(rejection.status(), rejection.message())),
            }
        };

    let websocket = tokio_tungstenite::accept_hdr_async(stream, callback)
        .await
        .context("websocket handshake failed")?;

    // Set by the handshake callback above, which has run by the time the socket is accepted.
    // An absent grant means the callback did not run, which cannot happen on an accepted
    // socket - failing closed rather than defaulting to an authority nobody granted.
    let grant = grant_cell
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .context("the handshake produced no authority")?;
    let mut principal = match grant {
        HandshakeGrant::Identified(identity) => {
            tracing::info!(
                %peer,
                user = %identity.username,
                user_id = %identity.user_id,
                role = identity.role.as_str(),
                session = %identity.session_id,
                "authenticated a connection"
            );
            ConnectionPrincipal::identified(peer.clone(), *identity)
        }
        HandshakeGrant::AnonymousLocalEditor => {
            tracing::warn!(
                %peer,
                "accepted an unauthenticated local connection; this engine requires no authentication"
            );
            ConnectionPrincipal::loopback_editor(peer.clone())
        }
    };

    let (mut sink, mut source) = websocket.split();
    let mut events = engine.lock().await.subscribe_events();

    {
        let mut guard = engine.lock().await;
        guard.connected_clients += 1;
        tracing::info!(%peer, clients = guard.connected_clients, "client connected");
    }

    let client_id = peer.clone();
    let mut outbound_sequence = 0_u64;
    let mut inbound = SequenceTracker::new(32);
    let mut dedupe = MessageDeduplicator::new(4096, 60_000);
    let mut limiter = RateLimiter::new(
        config.security.rate_limit_burst,
        config.security.rate_limit_per_second,
        now_ms(),
    );

    let result = loop {
        tokio::select! {
            incoming = source.next() => {
                let Some(message) = incoming else { break Ok(()); };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => break Err(anyhow::anyhow!(error)),
                };

                match message {
                    Message::Text(text) => {
                        let replies = process_frame(
                            &text,
                            &engine,
                            &config,
                            &client_id,
                            &mut principal,
                            &mut inbound,
                            &mut dedupe,
                            &mut limiter,
                            &mut outbound_sequence,
                        ).await;

                        for reply in replies {
                            let encoded = protocol::encode(&reply)
                                .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
                            if sink.send(Message::Text(encoded.into())).await.is_err() {
                                break;
                            }
                            engine.lock().await.messages_sent += 1;
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Message::Close(_) => break Ok(()),
                    // Protocol v3 is JSON only. Ignoring binary is safer than
                    // guessing at an encoding.
                    Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
                }
            }

            event = events.recv() => {
                match event {
                    Ok(event) => {
                        // An addressed event belongs to one client. Skipping it here
                        // costs nothing and keeps a preview stream off every other
                        // socket.
                        if let Some(target) = &event.target_client {
                            if target != &client_id {
                                continue;
                            }
                        }
                        if let Some(bytes) = event.binary {
                            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                                break Ok(());
                            }
                            engine.lock().await.messages_sent += 1;
                            continue;
                        }
                        let mut envelope = event.envelope;
                        outbound_sequence += 1;
                        envelope.sequence = outbound_sequence;
                        let encoded = protocol::encode(&envelope)
                            .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
                        if sink.send(Message::Text(encoded.into())).await.is_err() {
                            break Ok(());
                        }
                        engine.lock().await.messages_sent += 1;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        // Events are advisory; a slow client missing some is not a
                        // reason to drop it, but it must be visible.
                        tracing::warn!(%peer, skipped, "client lagged behind the event stream");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break Ok(()),
                }
            }
        }
    };

    {
        let mut guard = engine.lock().await;
        guard.connected_clients = guard.connected_clients.saturating_sub(1);
        // Its preview streams go with it. Otherwise a reconnecting Editor accumulates
        // streams that render frames nobody receives - GPU time spent on nothing.
        guard.drop_streams_for_client(&client_id);
        // A controller disconnecting must never take Program down. Program state
        // lives in the engine, so there is deliberately nothing to clean up here.
        tracing::info!(%peer, clients = guard.connected_clients, "client disconnected");
    }

    result
}

/// Process one text frame and produce the replies to send.
///
/// Shared with the IPC transport on purpose: both must enforce the same size limit, rate
/// limit, authentication, ordering and duplicate rules, in the same order. Two copies of
/// this logic would drift, and the drift would be a security difference between two ways
/// of reaching the same engine.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_frame(
    text: &str,
    engine: &Arc<Mutex<Engine>>,
    config: &EngineConfig,
    client_id: &str,
    principal: &mut ConnectionPrincipal,
    inbound: &mut SequenceTracker,
    dedupe: &mut MessageDeduplicator,
    limiter: &mut RateLimiter,
    outbound_sequence: &mut u64,
) -> Vec<Envelope> {
    let engine_id = { engine.lock().await.engine_id.clone() };
    let now = now_ms();

    let mut make_error = |error: ProtocolError, request_id: Option<String>| -> Envelope {
        *outbound_sequence += 1;
        Envelope::reply(
            "reply.error",
            error.to_payload(),
            request_id,
            &engine_id,
            *outbound_sequence,
            now,
        )
    };

    // 1. Size and structure, before anything else.
    let envelope = match protocol::decode(text, config.security.max_message_bytes) {
        Ok(envelope) => envelope,
        Err(error) => {
            tracing::debug!(
                %client_id,
                code = error.code.as_str(),
                reason = %error.message,
                "rejected a frame"
            );
            /*
             * A refusal the client cannot match to its request is not an answer. An oversized frame
             * is rejected before parsing — deliberately, so an unbounded frame is never a denial of
             * service — which used to mean the caller waited out its own timeout and reported
             * "connection closed: reconnecting" instead of the limit it had exceeded. Recovering
             * the id costs a bounded scan of the head of the frame, never a parse of all of it.
             */
            return vec![make_error(error, request_id_from_frame_head(text))];
        }
    };

    {
        engine.lock().await.messages_received += 1;
    }

    let request_id = envelope.request_id.clone();
    let Some(request) = RequestType::parse(&envelope.message_type) else {
        return vec![make_error(
            ProtocolError::new(
                ErrorCode::UnsupportedMessage,
                format!("unknown message type {}", envelope.message_type),
            ),
            request_id,
        )];
    };

    // 2. Rate limit. Heartbeats cost nothing so liveness is never throttled.
    let cost = request.rate_cost();
    if cost > 0.0 && !limiter.try_consume(now, cost) {
        let retry_after = limiter.retry_after_ms(now, cost);
        return vec![make_error(
            ProtocolError::new(
                ErrorCode::RateLimited,
                format!("rate limit exceeded; retry in {retry_after}ms"),
            ),
            request_id,
        )];
    }

    // 3. IPC obtains its principal here; WebSocket obtains it in its authenticated handshake.
    // The credential is verified before it can change the session's authority, and the same
    // verifier is used on both transports so there is one place to audit.
    if request == RequestType::Authenticate && !principal.is_authenticated() {
        let presented = envelope
            .payload
            .get("token")
            .and_then(serde_json::Value::as_str);
        let key = config.resolve_signing_key().ok().flatten();
        match (key, presented) {
            (Some(key), Some(presented)) => {
                match crate::auth::verify_access_token(presented, &key, now_seconds()) {
                    Ok(identity) => {
                        tracing::info!(
                            user = %identity.username,
                            role = identity.role.as_str(),
                            session = %identity.session_id,
                            "authenticated a session"
                        );
                        *principal = ConnectionPrincipal::identified(client_id, identity);
                    }
                    Err(error) => {
                        return vec![make_error(
                            ProtocolError::new(ErrorCode::Unauthenticated, error.as_str()),
                            request_id,
                        )];
                    }
                }
            }
            _ => {
                return vec![make_error(
                    ProtocolError::new(
                        ErrorCode::Unauthenticated,
                        "connection credential was rejected",
                    ),
                    request_id,
                )];
            }
        }
    }

    // An identified principal is the only kind a production engine acts on.
    //
    // The WebSocket handshake already refuses a credential-less connection when auth is
    // required, and IPC has no handshake at all - so this is where an IPC session that never
    // authenticated is stopped. "Including localhost" is the requirement and the pipe is as
    // local as it gets: a local process is not a person, and a scene that reached air with
    // nobody's name on it is exactly what the audit trail exists to prevent.
    if config.auth.required && !principal.is_authenticated() && !request.allowed_unauthenticated()
    {
        return vec![make_error(
            ProtocolError::new(
                ErrorCode::Unauthenticated,
                format!(
                    "{} requires an authenticated session; send connection.authenticate with an access token",
                    envelope.message_type
                ),
            ),
            request_id,
        )];
    }

    // 3b. Project scope is part of SceneRef, never a separate mutable envelope
    // field that could disagree with the runtime key.
    if !config.auth.allowed_projects.is_empty() {
        if let Some(scene_ref) = &envelope.scene_ref {
            if !config.auth.allowed_projects.contains(&scene_ref.project_id) {
                return vec![make_error(
                    ProtocolError::new(
                        ErrorCode::ProjectNotPermitted,
                        format!(
                            "this engine does not serve project {}",
                            scene_ref.project_id
                        ),
                    ),
                    request_id,
                )];
            }
        }
    }

    // 4. Ordering. Applying Take before its Cue would put the wrong thing on air.
    //
    // This runs *before* duplicate suppression, and the order is load-bearing. A
    // retransmit reuses its `messageId` but is sent with a fresh sequence number,
    // because the sequence is per-connection and strictly increasing. If dedupe
    // short-circuited first, that sequence would never be consumed and every later
    // message would look like it had arrived early — the connection would wedge
    // permanently on the first retransmission.
    let (verdict, _released) = inbound.offer(envelope.sequence);
    match verdict {
        SequenceVerdict::Duplicate => {
            let mut guard = engine.lock().await;
            guard.duplicates_dropped += 1;
            drop(guard);
            return Vec::new();
        }
        SequenceVerdict::Gap => {
            let mut guard = engine.lock().await;
            guard.sequence_gaps += 1;
            guard.resync_count += 1;
            drop(guard);

            tracing::warn!(
                %client_id,
                sequence = envelope.sequence,
                expected = inbound.expected(),
                "inbound sequence gap; requiring a resync"
            );
            return vec![make_error(
                ProtocolError::new(
                    ErrorCode::SequenceGap,
                    format!(
                        "sequence {} arrived with {} expected; resend the scene with scene.fullSync",
                        envelope.sequence,
                        inbound.expected()
                    ),
                ),
                request_id,
            )];
        }
        SequenceVerdict::Future => {
            // Parked. It will be released when the gap closes.
            return Vec::new();
        }
        SequenceVerdict::Accept => {}
    }

    // 5. Duplicate suppression, once the sequence has been accounted for.
    //
    // A retransmit is acknowledged and *not* re-applied: replaying a Take or an
    // asset release because a reply was lost would be worse than the lost reply.
    if dedupe.check(&envelope.message_id, now) {
        {
            let mut guard = engine.lock().await;
            guard.duplicates_dropped += 1;
        }

        tracing::debug!(%client_id, message_id = %envelope.message_id, "suppressed a duplicate");
        *outbound_sequence += 1;
        return vec![Envelope::reply(
            "reply.ack",
            serde_json::json!({
                "requestType": envelope.message_type,
                "warnings": ["duplicate message suppressed; no action was taken"],
            }),
            request_id,
            &engine_id,
            *outbound_sequence,
            now,
        )];
    }

    // 6. Dispatch.
    let outcome = {
        let mut guard = engine.lock().await;
        guard.handle(request, &envelope, principal)
    };

    match outcome {
        Ok((reply_type, payload)) => {
            *outbound_sequence += 1;
            vec![Envelope::reply(
                &reply_type,
                payload,
                request_id,
                &engine_id,
                *outbound_sequence,
                now,
            )]
        }
        Err(error) => {
            tracing::debug!(
                %client_id,
                message_type = %envelope.message_type,
                code = error.code.as_str(),
                message = %error.message,
                "refused a request"
            );
            vec![make_error(error, request_id)]
        }
    }
}

fn validate_handshake(
    request: &Request,
    security: &HandshakeSecurity,
    peer: &str,
) -> Result<HandshakeGrant, HandshakeRejection> {
    // Origin: only relevant for browser clients, and only checked when configured.
    if !security.allowed_origins.is_empty() {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !security.allowed_origins.contains(origin) {
            return Err(HandshakeRejection::OriginForbidden);
        }
    }

    // Client allowlist, matched on host without the ephemeral port.
    if !security.client_allowlist.is_empty() {
        let host = peer.rsplit_once(':').map(|(host, _)| host).unwrap_or(peer);
        if !security.client_allowlist.contains(host) {
            return Err(HandshakeRejection::ClientNotAllowlisted);
        }
    }

    let protocols: Vec<&str> = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').map(str::trim).collect())
        .unwrap_or_default();

    if !protocols.contains(&ENGINE_SUBPROTOCOL) {
        return Err(HandshakeRejection::SubprotocolMissing);
    }
    // The token travels as a subprotocol rather than a query parameter: query strings end up
    // in proxy logs and browser history.
    let presented = protocols
        .iter()
        .find_map(|value| value.strip_prefix(BEARER_PREFIX));

    // Order matters. A development engine that *can* verify a token identifies the user when
    // one is presented, but still serves a local peer without one - otherwise the developer
    // convenience would require every test and local tool to mint a credential. A production
    // engine verifies when a token is presented and refuses everything else, from any
    // address including this machine's own.
    if !security.auth_required && is_loopback_peer(peer) {
        match (presented, &security.signing_key) {
            (Some(token), Some(key)) => match crate::auth::verify_access_token(token, key, now_seconds()) {
                Ok(identity) => return Ok(HandshakeGrant::Identified(Box::new(identity))),
                // An unverifiable token is noise on a dev engine, not authority. Falling
                // through to the anonymous session keeps development possible without
                // pretending the credential checked out.
                Err(_) => return Ok(HandshakeGrant::AnonymousLocalEditor),
            },
            _ => return Ok(HandshakeGrant::AnonymousLocalEditor),
        }
    }

    // From here the engine requires authentication.
    if let Some(token) = presented {
        let Some(key) = &security.signing_key else {
            // auth.required with no key is a misconfiguration the validator already refuses;
            // failing closed is the backstop.
            return Err(HandshakeRejection::AuthenticationFailed);
        };
        return match crate::auth::verify_access_token(token, key, now_seconds()) {
            Ok(identity) => Ok(HandshakeGrant::Identified(Box::new(identity))),
            Err(error) => {
                tracing::warn!(%peer, reason = error.as_str(), "refused a connection token");
                Err(HandshakeRejection::AuthenticationFailed)
            }
        };
    }

    // No credential on an engine that requires one. "Including localhost" is the requirement:
    // a local process is not a person, and an audit trail that cannot name who cued a scene
    // is not an audit trail.
    Err(HandshakeRejection::AuthenticationFailed)
}

/// Seconds since the epoch, for token expiry.
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn handshake_error(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}

/// Pull `requestId` out of the head of a frame that was refused before parsing.
///
/// Bounded on purpose: a refused frame may be enormous, and the reason it was refused is that the
/// engine will not spend the memory to parse it. The envelope writes its metadata first, so the id
/// is within the first few hundred bytes of anything this codebase sends; if it is not there, the
/// reply carries no id, exactly as before.
fn request_id_from_frame_head(raw: &str) -> Option<String> {
    const SCAN_BYTES: usize = 2048;

    let head = raw.get(..raw.len().min(SCAN_BYTES)).unwrap_or(raw);
    let key = "\"requestId\"";
    let start = head.find(key)? + key.len();
    let rest = head.get(start..)?.trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let id = &rest[..end];

    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    const SECRET: &str = "a-thirty-two-character-test-secret-01234";

    fn security(auth_required: bool) -> HandshakeSecurity {
        HandshakeSecurity {
            signing_key: Some(SECRET.as_bytes().to_vec()),
            auth_required,
            allowed_origins: HashSet::new(),
            client_allowlist: HashSet::new(),
        }
    }

    /// Mint a token the way the TypeScript issuer does. The format is proven identical by
    /// `Shared/auth-contract/tests/conformance.test.mjs`; this just needs a valid one.
    fn token_for(role: &str, perms: &[&str], exp: u64) -> String {
        let perms = perms
            .iter()
            .map(|p| format!("\"{p}\""))
            .collect::<Vec<_>>()
            .join(",");
        let payload = format!(
            r#"{{"sub":"usr_1","usr":"ada","role":"{role}","perms":[{perms}],"sid":"sess_1","typ":"access","iat":1,"exp":{exp}}}"#
        );
        let encoded = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let signing_input = format!("gx1.{encoded}");
        let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).expect("key");
        mac.update(signing_input.as_bytes());
        format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    fn handshake(
        peer: &str,
        protocols: &str,
        security: &HandshakeSecurity,
    ) -> Result<HandshakeGrant, HandshakeRejection> {
        let request = Request::builder()
            .header("sec-websocket-protocol", protocols)
            .body(())
            .expect("request");
        validate_handshake(&request, security, peer)
    }

    #[test]
    fn a_production_engine_refuses_localhost_without_a_token() {
        // The requirement, stated as a test: "including localhost". A local process is not a
        // person, and an audit trail that cannot name who cued a scene is not an audit trail.
        assert_eq!(
            handshake("127.0.0.1:51000", ENGINE_SUBPROTOCOL, &security(true)),
            Err(HandshakeRejection::AuthenticationFailed)
        );
        assert_eq!(
            handshake("[::1]:51000", ENGINE_SUBPROTOCOL, &security(true)),
            Err(HandshakeRejection::AuthenticationFailed)
        );
    }

    #[test]
    fn a_valid_token_carries_its_user_onto_the_connection() {
        let protocols = format!(
            "{ENGINE_SUBPROTOCOL}, {BEARER_PREFIX}{}",
            token_for("editor", &["scene.write"], 9_999_999_999)
        );
        match handshake("10.0.0.7:51000", &protocols, &security(true)) {
            Ok(HandshakeGrant::Identified(identity)) => {
                assert_eq!(identity.username, "ada");
                assert_eq!(identity.role, crate::auth::UserRole::Editor);
                assert!(identity.allows(crate::auth::Permission::SceneWrite));
                assert!(!identity.allows(crate::auth::Permission::PlayoutProgram));
            }
            other => panic!("expected an identified grant, got {other:?}"),
        }
    }

    #[test]
    fn a_forged_or_expired_token_is_refused_from_loopback_too() {
        let forged = format!("{ENGINE_SUBPROTOCOL}, {BEARER_PREFIX}gx1.YWJj.ZGVm");
        assert_eq!(
            handshake("127.0.0.1:51000", &forged, &security(true)),
            Err(HandshakeRejection::AuthenticationFailed)
        );

        let expired = format!(
            "{ENGINE_SUBPROTOCOL}, {BEARER_PREFIX}{}",
            token_for("admin", &["playout.program"], 100)
        );
        assert_eq!(
            handshake("127.0.0.1:51000", &expired, &security(true)),
            Err(HandshakeRejection::AuthenticationFailed)
        );
    }

    #[test]
    fn a_development_engine_still_serves_a_local_peer_with_no_token() {
        assert_eq!(
            handshake("127.0.0.1:51000", ENGINE_SUBPROTOCOL, &security(false)),
            Ok(HandshakeGrant::AnonymousLocalEditor)
        );
    }

    #[test]
    fn a_development_engine_is_still_not_an_open_door() {
        // No authentication configured is a developer convenience, not an invitation to the
        // network. A remote peer is refused whatever the mode.
        assert_eq!(
            handshake("10.0.0.7:51000", ENGINE_SUBPROTOCOL, &security(false)),
            Err(HandshakeRejection::AuthenticationFailed)
        );
    }

    #[test]
    fn a_dev_engine_identifies_a_verified_token_and_ignores_a_forged_one() {
        // On a development engine a good token still identifies its user - the audit rows
        // carry a real name - and a forged one simply grants no authority, falling back to
        // the same anonymous session a tokenless peer would have had. Refusing it instead
        // would make a development engine require a credential it was configured not to.
        let good = format!(
            "{ENGINE_SUBPROTOCOL}, {BEARER_PREFIX}{}",
            token_for("admin", &["playout.program"], 9_999_999_999)
        );
        match handshake("127.0.0.1:51000", &good, &security(false)) {
            Ok(HandshakeGrant::Identified(identity)) => {
                assert_eq!(identity.role, crate::auth::UserRole::Admin);
            }
            other => panic!("expected an identified grant, got {other:?}"),
        }

        let forged = format!("{ENGINE_SUBPROTOCOL}, {BEARER_PREFIX}gx1.YWJj.ZGVm");
        assert_eq!(
            handshake("127.0.0.1:51000", &forged, &security(false)),
            Ok(HandshakeGrant::AnonymousLocalEditor)
        );
    }

    #[test]
    fn loopback_is_recognised_in_both_address_families() {
        assert!(is_loopback_peer("127.0.0.1:4400"));
        assert!(is_loopback_peer("[::1]:4400"));
        assert!(!is_loopback_peer("10.0.0.7:4400"));
        assert!(!is_loopback_peer("unknown"));
    }
}
