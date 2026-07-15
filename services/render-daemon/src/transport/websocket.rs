//! WebSocket server: accepts local controller connections, parses protocol
//! messages, dispatches to the controller, and replies.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

use crate::config::{DaemonConfig, OutputConfig};
use crate::controller::DaemonController;
use crate::protocol::{
    parse_client_message, ClientMessage, ErrorCode, ProtocolError, ServerMessage,
};

struct HandshakeSecurity {
    auth_token: String,
    allowed_origins: HashSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum HandshakeRejection {
    OriginForbidden,
    AuthenticationFailed,
}

impl HandshakeRejection {
    fn status(&self) -> StatusCode {
        match self {
            HandshakeRejection::OriginForbidden => StatusCode::FORBIDDEN,
            HandshakeRejection::AuthenticationFailed => StatusCode::UNAUTHORIZED,
        }
    }

    fn message(&self) -> &'static str {
        match self {
            HandshakeRejection::OriginForbidden => "WebSocket Origin is not allowed",
            HandshakeRejection::AuthenticationFailed => "render daemon authentication failed",
        }
    }
}

pub async fn serve(
    config: DaemonConfig,
    controller: Arc<Mutex<DaemonController>>,
) -> anyhow::Result<()> {
    let address = format!("{}:{}", config.host, config.port);
    let security = Arc::new(HandshakeSecurity {
        auth_token: config.auth_token,
        allowed_origins: config.allowed_origins.into_iter().collect(),
    });
    let listener = TcpListener::bind(&address)
        .await
        .with_context(|| format!("failed to bind WebSocket server on {address}"))?;

    tracing::info!(%address, "render daemon listening (ws://{address})");

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        let controller = Arc::clone(&controller);
                        let security = Arc::clone(&security);
                        tokio::spawn(async move {
                            if let Err(error) = handle_connection(stream, controller, security).await {
                                tracing::warn!(%peer, %error, "connection ended with error");
                            }
                        });
                    }
                    Err(error) => tracing::warn!(%error, "failed to accept connection"),
                }
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutdown signal received");
                controller.lock().await.shutdown();
                return Ok(());
            }
        }
    }
}

async fn handle_connection(
    stream: TcpStream,
    controller: Arc<Mutex<DaemonController>>,
    security: Arc<HandshakeSecurity>,
) -> anyhow::Result<()> {
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let callback =
        move |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            match validate_handshake(request, &security) {
                Ok(()) => Ok(response),
                Err(rejection) => Err(handshake_error(rejection.status(), rejection.message())),
            }
        };
    let websocket = tokio_tungstenite::accept_hdr_async(stream, callback)
        .await
        .context("websocket handshake failed")?;
    let (mut sink, mut source) = websocket.split();

    let client_counter = {
        let controller = controller.lock().await;
        Arc::clone(&controller.connected_clients)
    };
    client_counter.fetch_add(1, Ordering::Relaxed);
    tracing::info!(%peer, clients = client_counter.load(Ordering::Relaxed), "controller connected");

    // A controller disconnect must never take the output down: the render
    // loop keeps running on the last received scene; the controller can
    // reconnect and resync at any time.
    while let Some(message) = source.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(%peer, %error, "websocket read error; dropping connection");
                break;
            }
        };

        let reply = match message {
            Message::Text(text) => Some(dispatch(text.as_str(), &controller).await),
            Message::Binary(_) => Some(ServerMessage::error(ProtocolError::new(
                ErrorCode::UnsupportedMessage,
                "binary frames are not part of protocol v1; send JSON text frames",
            ))),
            Message::Close(_) => break,
            // Ping/pong are handled by tungstenite automatically.
            _ => None,
        };

        if let Some(reply) = reply {
            if sink
                .send(Message::Text(reply.to_json().into()))
                .await
                .is_err()
            {
                break;
            }
        }
    }

    client_counter.fetch_sub(1, Ordering::Relaxed);
    tracing::info!(%peer, clients = client_counter.load(Ordering::Relaxed), "controller disconnected");

    Ok(())
}

fn validate_handshake(
    request: &Request,
    security: &HandshakeSecurity,
) -> Result<(), HandshakeRejection> {
    if let Some(origin) = request.headers().get("origin") {
        let origin = origin.to_str().unwrap_or_default();
        if !security.allowed_origins.contains(origin) {
            return Err(HandshakeRejection::OriginForbidden);
        }
    }

    let supplied_token = request
        .uri()
        .query()
        .and_then(|query| {
            query
                .split('&')
                .filter_map(|pair| pair.split_once('='))
                .find(|(name, _)| *name == "token")
        })
        .map(|(_, value)| value)
        .unwrap_or_default();

    if !constant_time_eq(supplied_token.as_bytes(), security.auth_token.as_bytes()) {
        return Err(HandshakeRejection::AuthenticationFailed);
    }

    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right)
        .fold(0u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

fn handshake_error(status: StatusCode, message: &str) -> ErrorResponse {
    tokio_tungstenite::tungstenite::http::Response::builder()
        .status(status)
        .body(Some(message.to_string()))
        .expect("static handshake error response must be valid")
}

async fn dispatch(text: &str, controller: &Arc<Mutex<DaemonController>>) -> ServerMessage {
    let message = match parse_client_message(text) {
        Ok(message) => message,
        Err(error) => return ServerMessage::error(error),
    };

    let message_type = message.message_type();
    let request_id = message.request_id().map(str::to_string);
    let mut controller = controller.lock().await;

    let result = match message {
        ClientMessage::SceneLoad { scene, .. } | ClientMessage::SceneUpdate { scene, .. } => {
            controller.load_scene(&scene).map(Some)
        }
        ClientMessage::OutputConfigure { config, .. } => OutputConfig::from_message(config)
            .map_err(|error| ProtocolError::new(ErrorCode::InvalidOutputConfig, error.to_string()))
            .and_then(|config| controller.configure_output(config))
            .map(|()| None),
        ClientMessage::OutputStart { .. } => controller.start_output().map(|()| None),
        ClientMessage::OutputStop { .. } => controller.stop_output().map(|()| None),
        ClientMessage::Status { .. } => {
            let report = controller.status();
            return ServerMessage::status(request_id, report);
        }
    };

    match result {
        Ok(warnings) => ServerMessage::ack(message_type, request_id, warnings.unwrap_or_default()),
        Err(error) => ServerMessage::error(error.with_request_id(request_id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn security(allowed_origins: &[&str]) -> HandshakeSecurity {
        HandshakeSecurity {
            auth_token: "a".repeat(32),
            allowed_origins: allowed_origins
                .iter()
                .map(|origin| (*origin).to_string())
                .collect(),
        }
    }

    fn request(uri: &str, origin: Option<&str>) -> Request {
        let mut builder = Request::builder().uri(uri);
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        builder.body(()).expect("test request must be valid")
    }

    #[test]
    fn accepts_authenticated_non_browser_client() {
        let request = request(&format!("/?token={}", "a".repeat(32)), None);
        assert!(validate_handshake(&request, &security(&[])).is_ok());
    }

    #[test]
    fn rejects_missing_authentication() {
        let request = request("/", None);
        let error = validate_handshake(&request, &security(&[])).unwrap_err();
        assert_eq!(error, HandshakeRejection::AuthenticationFailed);
    }

    #[test]
    fn rejects_unlisted_browser_origin() {
        let request = request(
            &format!("/?token={}", "a".repeat(32)),
            Some("https://attacker.example"),
        );
        let error =
            validate_handshake(&request, &security(&["http://127.0.0.1:5173"])).unwrap_err();
        assert_eq!(error, HandshakeRejection::OriginForbidden);
    }

    #[test]
    fn accepts_explicitly_allowed_browser_origin() {
        let request = request(
            &format!("/?token={}", "a".repeat(32)),
            Some("http://127.0.0.1:5173"),
        );
        assert!(validate_handshake(&request, &security(&["http://127.0.0.1:5173"])).is_ok());
    }
}
