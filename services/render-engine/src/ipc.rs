//! Local IPC transport.
//!
//! For the embedded deployment mode: a desktop shell that supervises its own engine on
//! the same machine. A local socket avoids the TCP stack, avoids the WebSocket handshake,
//! and — the part that matters for security — is not reachable from the network at all.
//! An engine can therefore serve a local Editor without ever opening a port.
//!
//! Platform mapping:
//!
//! | Platform | Endpoint |
//! | --- | --- |
//! | Windows | named pipe, e.g. `\\.\pipe\grapix-render-engine` |
//! | Unix | filesystem socket, e.g. `/tmp/grapix-render-engine.sock` |
//!
//! **Framing.** A four-byte big-endian length followed by that many bytes of UTF-8 JSON —
//! the same envelope as the WebSocket transport carries. A stream socket has no message
//! boundaries of its own, and newline-delimited framing would break the moment a payload
//! contained a newline (a base64 preview frame will not, but a scene's text content
//! certainly can). The length is checked against `security.max-message-bytes` *before*
//! any buffer is allocated, so an oversized declaration cannot make the engine allocate
//! for it.
//!
//! **Authentication.** The WebSocket transport carries the token in a subprotocol; there
//! is no equivalent here, so an IPC client presents it with `connection.authenticate`
//! like any other message. Everything except the handshake messages is refused until it
//! does. On Windows the pipe is created with default ACLs, which restrict it to the same
//! session; on Unix the socket file's permissions do the same job. Neither is a
//! substitute for the token when `auth.required` is set.
//!
//! Every reliability rule the WebSocket path enforces applies here unchanged, because
//! both call the same `process_frame`: size limit, rate limit, authentication, sequence
//! ordering, then duplicate suppression, in that order.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::capabilities::ConnectionPrincipal;
use crate::config::EngineConfig;
use crate::engine::Engine;
use crate::protocol;
use crate::security::{MessageDeduplicator, RateLimiter, SequenceTracker};

/// Length prefix width. Four bytes covers the largest message the engine will accept.
const LENGTH_PREFIX_BYTES: usize = 4;

/// Encode one message with its length prefix.
pub fn frame(payload: &str) -> Vec<u8> {
    let bytes = payload.as_bytes();
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + bytes.len());
    framed.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    framed.extend_from_slice(bytes);
    framed
}

/// Read one length-prefixed message.
///
/// Returns `Ok(None)` at a clean end of stream. An oversized length is an error *before*
/// the body is read, so a client cannot make the engine allocate gigabytes by lying about
/// a length it never sends.
pub async fn read_frame<R>(reader: &mut R, max_bytes: usize) -> std::io::Result<Option<String>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut length_bytes = [0u8; LENGTH_PREFIX_BYTES];
    match reader.read_exact(&mut length_bytes).await {
        Ok(_) => {}
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::BrokenPipe
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    }

    let length = u32::from_be_bytes(length_bytes) as usize;
    if length == 0 {
        return Ok(Some(String::new()));
    }
    if length > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("frame declares {length} bytes; this engine accepts at most {max_bytes}"),
        ));
    }

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    String::from_utf8(body)
        .map(Some)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

/// Serve the configured IPC endpoint, if there is one.
///
/// Returns immediately when no endpoint is configured: IPC is opt-in, and a deployment
/// that does not use it should not have a socket appear.
pub async fn serve(config: EngineConfig, engine: Arc<Mutex<Engine>>) -> anyhow::Result<()> {
    let Some(endpoint) = config.network.ipc_endpoint.clone() else {
        return Ok(());
    };

    tracing::info!(%endpoint, "engine listening on local IPC");
    serve_endpoint(endpoint, config, engine).await
}

#[cfg(windows)]
async fn serve_endpoint(
    endpoint: String,
    config: EngineConfig,
    engine: Arc<Mutex<Engine>>,
) -> anyhow::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    // A named pipe server instance serves exactly one client, so the next instance has to
    // be created before the current one is handed off. Creating it after would leave a
    // window in which a connecting client is refused.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&endpoint)?;

    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(&endpoint)?;

        let config = config.clone();
        let engine = Arc::clone(&engine);
        let client_id = format!("ipc:{endpoint}");
        tokio::spawn(async move {
            if let Err(error) = handle_connection(connected, config, engine, client_id).await {
                tracing::debug!(%error, "ipc connection ended");
            }
        });
    }
}

#[cfg(unix)]
async fn serve_endpoint(
    endpoint: String,
    config: EngineConfig,
    engine: Arc<Mutex<Engine>>,
) -> anyhow::Result<()> {
    use tokio::net::UnixListener;

    // A socket file left behind by a crash would make bind fail. Removing it is safe
    // because a live engine holds the file open and a second engine on the same endpoint
    // is a configuration error either way.
    let _ = std::fs::remove_file(&endpoint);
    let listener = UnixListener::bind(&endpoint)?;

    loop {
        let (stream, _) = listener.accept().await?;
        let config = config.clone();
        let engine = Arc::clone(&engine);
        let client_id = format!("ipc:{endpoint}");
        tokio::spawn(async move {
            if let Err(error) = handle_connection(stream, config, engine, client_id).await {
                tracing::debug!(%error, "ipc connection ended");
            }
        });
    }
}

#[cfg(not(any(windows, unix)))]
async fn serve_endpoint(
    _endpoint: String,
    _config: EngineConfig,
    _engine: Arc<Mutex<Engine>>,
) -> anyhow::Result<()> {
    // Refused rather than silently ignored: a deployment that configured IPC and got
    // nothing would look like a working engine that no client can reach.
    anyhow::bail!("local IPC is not supported on this platform; use the WebSocket transport")
}

/// Serve one IPC client until it disconnects.
///
/// Structured exactly like the WebSocket connection loop, and calls the same
/// `process_frame`, so the reliability and security rules cannot drift between the two
/// transports.
async fn handle_connection<S>(
    stream: S,
    config: EngineConfig,
    engine: Arc<Mutex<Engine>>,
    client_id: String,
) -> anyhow::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);

    let mut events = engine.lock().await.subscribe_events();
    {
        let mut guard = engine.lock().await;
        guard.connected_clients += 1;
        tracing::info!(%client_id, clients = guard.connected_clients, "ipc client connected");
    }

    // IPC begins as a private Editor session. `process_frame` replaces this
    // immutable principal only after validating connection.authenticate.
    let mut principal = ConnectionPrincipal::loopback_editor(client_id.clone());

    // The same windows the WebSocket path uses: the two transports must not differ in
    // how much reordering or retransmission they tolerate.
    let mut inbound = SequenceTracker::new(32);
    let mut dedupe = MessageDeduplicator::new(4096, 60_000);
    let mut limiter = RateLimiter::new(
        config.security.rate_limit_burst,
        config.security.rate_limit_per_second,
        crate::protocol::now_ms(),
    );
    let mut outbound_sequence: u64 = 0;
    let max_bytes = config.security.max_message_bytes as usize;

    let result = loop {
        tokio::select! {
            frame_read = read_frame(&mut reader, max_bytes) => {
                match frame_read {
                    Ok(Some(text)) => {
                        let replies = crate::transport::process_frame(
                            &text,
                            &engine,
                            &config,
                            &client_id,
                            &mut principal,
                            &mut inbound,
                            &mut dedupe,
                            &mut limiter,
                            &mut outbound_sequence,
                        )
                        .await;

                        for envelope in replies {
                            let encoded = protocol::encode(&envelope)
                                .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
                            if writer.write_all(&frame(&encoded)).await.is_err() {
                                break;
                            }
                        }
                        if writer.flush().await.is_err() {
                            break Ok(());
                        }
                    }
                    Ok(None) => break Ok(()),
                    Err(error) => {
                        tracing::debug!(%client_id, %error, "ipc frame rejected");
                        break Ok(());
                    }
                }
            }

            event = events.recv() => {
                match event {
                    Ok(event) => {
                        // Addressed events belong to one client, exactly as on the
                        // WebSocket path.
                        if let Some(target) = &event.target_client {
                            if target != &client_id {
                                continue;
                            }
                        }
                        // Native Editor views are WebSocket binary frames. Never
                        // downgrade them into an IPC JSON event or base64 payload.
                        if event.binary.is_some() {
                            continue;
                        }
                        let mut envelope = event.envelope;
                        outbound_sequence += 1;
                        envelope.sequence = outbound_sequence;
                        let encoded = protocol::encode(&envelope)
                            .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
                        if writer.write_all(&frame(&encoded)).await.is_err() {
                            break Ok(());
                        }
                        if writer.flush().await.is_err() {
                            break Ok(());
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(%client_id, skipped, "ipc client lagged behind the event stream");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break Ok(()),
                }
            }
        }
    };

    {
        let mut guard = engine.lock().await;
        guard.connected_clients = guard.connected_clients.saturating_sub(1);
        guard.drop_streams_for_client(&client_id);
        tracing::info!(%client_id, clients = guard.connected_clients, "ipc client disconnected");
    }

    result
}
