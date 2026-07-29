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

use crate::config::EngineConfig;
use crate::engine::Engine;
use crate::protocol::{self, now_ms, Envelope, ErrorCode, ProtocolError, RequestType};
use crate::security::{tokens_match, MessageDeduplicator, RateLimiter, SequenceTracker, SequenceVerdict};

/// Subprotocol the client must offer, so a stray browser tab cannot connect.
const ENGINE_SUBPROTOCOL: &str = "grapix-engine-v3";
const BEARER_PREFIX: &str = "bearer.";

struct HandshakeSecurity {
    /// `None` means a loopback engine running without authentication.
    auth_token: Option<String>,
    auth_required: bool,
    allowed_origins: HashSet<String>,
    client_allowlist: HashSet<String>,
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

    let auth_token = config
        .resolve_token()
        .context("failed to resolve the engine auth token")?;

    let security = Arc::new(HandshakeSecurity {
        auth_token,
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

    // Authentication happens in the handshake, so an unauthenticated client never
    // reaches the message loop at all.
    let mut authenticated = !security.auth_required;
    let handshake_security = Arc::clone(&security);
    let peer_for_callback = peer.clone();

    let callback = move |request: &Request, mut response: Response| -> Result<Response, ErrorResponse> {
        match validate_handshake(request, &handshake_security, &peer_for_callback) {
            Ok(()) => {
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

    if security.auth_required {
        // The handshake already verified the bearer subprotocol.
        authenticated = true;
    }

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
                            authenticated,
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
    authenticated: bool,
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
            tracing::debug!(%client_id, code = error.code.as_str(), "rejected a frame");
            return vec![make_error(error, None)];
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

    // 3. Authentication. Only the handshake works before a token is presented.
    if !authenticated && !request.allowed_unauthenticated() {
        return vec![make_error(
            ProtocolError::new(
                ErrorCode::Unauthenticated,
                format!(
                    "{} requires authentication; send connection.authenticate first",
                    envelope.message_type
                ),
            ),
            request_id,
        )];
    }

    // 3b. Project scope.
    if !config.auth.allowed_projects.is_empty() {
        if let Some(project_id) = &envelope.project_id {
            if !config.auth.allowed_projects.contains(project_id) {
                return vec![make_error(
                    ProtocolError::new(
                        ErrorCode::ProjectNotPermitted,
                        format!("this engine does not serve project {project_id}"),
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
        guard.handle(request, &envelope, client_id)
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
) -> Result<(), HandshakeRejection> {
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

    if !security.auth_required {
        return Ok(());
    }

    let Some(expected) = &security.auth_token else {
        // Auth required with no token configured is a misconfiguration the config
        // validator already refuses; failing closed here is the safe backstop.
        return Err(HandshakeRejection::AuthenticationFailed);
    };

    // The token travels as a subprotocol rather than a query parameter: query
    // strings end up in proxy logs and browser history.
    let presented = protocols
        .iter()
        .find_map(|value| value.strip_prefix(BEARER_PREFIX));

    match presented {
        Some(token) if tokens_match(expected, token) => Ok(()),
        _ => Err(HandshakeRejection::AuthenticationFailed),
    }
}

fn handshake_error(status: StatusCode, message: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(message.to_string()));
    *response.status_mut() = status;
    response
}
