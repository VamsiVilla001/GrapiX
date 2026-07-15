//! Versioned WebSocket protocol between GrapiX (Electron/Fastify) and the
//! render daemon.
//!
//! Wire format: one JSON object per text frame. Every message carries
//! `protocolVersion`. Scene payloads are full `SceneDocument` replacements —
//! the repository defines no patch format for renderers beyond full documents,
//! so v1 deliberately does not invent one.

use serde::Serialize;
use serde_json::Value;

use crate::config::OutputConfigMessage;

pub const PROTOCOL_VERSION: u64 = 1;

/// Messages the controller (Electron/Fastify) sends to the daemon.
#[derive(Debug)]
pub enum ClientMessage {
    /// Replace the current scene with a full `SceneDocument`.
    SceneLoad {
        request_id: Option<String>,
        scene: Value,
    },
    /// Update the scene. v1 semantics are identical to `scene.load`
    /// (full replacement); the distinct type exists so a future patch format
    /// can be added without breaking `scene.load`.
    SceneUpdate {
        request_id: Option<String>,
        scene: Value,
    },
    OutputConfigure {
        request_id: Option<String>,
        config: OutputConfigMessage,
    },
    OutputStart {
        request_id: Option<String>,
    },
    OutputStop {
        request_id: Option<String>,
    },
    Status {
        request_id: Option<String>,
    },
}

impl ClientMessage {
    pub fn request_id(&self) -> Option<&str> {
        match self {
            ClientMessage::SceneLoad { request_id, .. }
            | ClientMessage::SceneUpdate { request_id, .. }
            | ClientMessage::OutputConfigure { request_id, .. }
            | ClientMessage::OutputStart { request_id }
            | ClientMessage::OutputStop { request_id }
            | ClientMessage::Status { request_id } => request_id.as_deref(),
        }
    }

    pub fn message_type(&self) -> &'static str {
        match self {
            ClientMessage::SceneLoad { .. } => "scene.load",
            ClientMessage::SceneUpdate { .. } => "scene.update",
            ClientMessage::OutputConfigure { .. } => "output.configure",
            ClientMessage::OutputStart { .. } => "output.start",
            ClientMessage::OutputStop { .. } => "output.stop",
            ClientMessage::Status { .. } => "status",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidJson,
    ProtocolVersionMismatch,
    UnsupportedMessage,
    InvalidPayload,
    InvalidScene,
    InvalidOutputConfig,
    OutputStateError,
    RendererError,
}

#[derive(Debug, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
    pub request_id: Option<String>,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            request_id: None,
        }
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }
}

/// Parse one incoming text frame.
///
/// The envelope (`type`, `protocolVersion`, `requestId`) is inspected before
/// payload deserialization so version mismatches and unknown types produce
/// specific errors instead of generic serde failures.
pub fn parse_client_message(text: &str) -> Result<ClientMessage, ProtocolError> {
    let value: Value = serde_json::from_str(text).map_err(|error| {
        ProtocolError::new(
            ErrorCode::InvalidJson,
            format!("message is not valid JSON: {error}"),
        )
    })?;

    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string);

    let version = value.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(PROTOCOL_VERSION) {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolVersionMismatch,
            format!(
                "expected protocolVersion {PROTOCOL_VERSION}, got {}",
                version.map_or_else(|| "none".to_string(), |v| v.to_string())
            ),
        )
        .with_request_id(request_id));
    }

    let message_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let take_scene = |value: &Value| -> Result<Value, ProtocolError> {
        value
            .get("scene")
            .cloned()
            .filter(|scene| scene.is_object())
            .ok_or_else(|| {
                ProtocolError::new(ErrorCode::InvalidPayload, "missing object field \"scene\"")
            })
    };

    match message_type.as_str() {
        "scene.load" => Ok(ClientMessage::SceneLoad {
            scene: take_scene(&value).map_err(|error| error.with_request_id(request_id.clone()))?,
            request_id,
        }),
        "scene.update" => Ok(ClientMessage::SceneUpdate {
            scene: take_scene(&value).map_err(|error| error.with_request_id(request_id.clone()))?,
            request_id,
        }),
        "output.configure" => {
            let config: OutputConfigMessage =
                serde_json::from_value(value.clone()).map_err(|error| {
                    ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        format!("invalid output.configure payload: {error}"),
                    )
                    .with_request_id(request_id.clone())
                })?;

            Ok(ClientMessage::OutputConfigure { request_id, config })
        }
        "output.start" => Ok(ClientMessage::OutputStart { request_id }),
        "output.stop" => Ok(ClientMessage::OutputStop { request_id }),
        "status" => Ok(ClientMessage::Status { request_id }),
        other => Err(ProtocolError::new(
            ErrorCode::UnsupportedMessage,
            format!("unknown message type {other:?}"),
        )
        .with_request_id(request_id)),
    }
}

/// Messages the daemon sends back to controllers.
#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    #[serde(rename = "ack")]
    Ack {
        protocol_version: u64,
        request_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        warnings: Vec<String>,
    },
    #[serde(rename = "error")]
    Error {
        protocol_version: u64,
        code: ErrorCode,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename = "status")]
    Status {
        protocol_version: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        // Boxed: the report is much larger than the other variants
        // (clippy::large_enum_variant).
        #[serde(flatten)]
        report: Box<StatusReport>,
    },
}

impl ServerMessage {
    pub fn ack(request_type: &str, request_id: Option<String>, warnings: Vec<String>) -> Self {
        ServerMessage::Ack {
            protocol_version: PROTOCOL_VERSION,
            request_type: request_type.to_string(),
            request_id,
            warnings,
        }
    }

    pub fn error(error: ProtocolError) -> Self {
        ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            code: error.code,
            message: error.message,
            request_id: error.request_id,
        }
    }

    pub fn status(request_id: Option<String>, report: StatusReport) -> Self {
        ServerMessage::Status {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            report: Box::new(report),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server messages contain only serializable fields")
    }
}

/// Diagnostics snapshot; serialized into `status` replies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub connected_clients: usize,
    pub scene: Option<SceneStatus>,
    pub gpu: GpuStatus,
    pub output: OutputStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneStatus {
    pub id: String,
    pub name: String,
    /// `SceneDocument.updatedAt` — the closest thing the model has to a
    /// revision; controllers can use it to confirm which save is live.
    pub revision: String,
    pub object_count: usize,
    pub rect_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub adapter: String,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    /// "idle" | "configured" | "running"
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<crate::config::OutputConfig>,
    pub frames_rendered: u64,
    pub frames_sent: u64,
    pub frames_dropped: u64,
    /// Milliseconds spent rendering + reading back the most recent frame.
    pub last_render_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scene_load() {
        let message = parse_client_message(
            r#"{"type":"scene.load","protocolVersion":1,"requestId":"req_1","scene":{"id":"s1"}}"#,
        )
        .expect("scene.load must parse");

        match message {
            ClientMessage::SceneLoad { request_id, scene } => {
                assert_eq!(request_id.as_deref(), Some("req_1"));
                assert_eq!(scene.get("id").and_then(|v| v.as_str()), Some("s1"));
            }
            other => panic!("expected SceneLoad, got {other:?}"),
        }
    }

    #[test]
    fn parses_output_configure() {
        let message = parse_client_message(
            r#"{
                "type": "output.configure",
                "protocolVersion": 1,
                "width": 1280,
                "height": 720,
                "frameRateNumerator": 60000,
                "frameRateDenominator": 1001,
                "ndiSourceName": "GrapiX Program",
                "backend": "null"
            }"#,
        )
        .expect("output.configure must parse");

        match message {
            ClientMessage::OutputConfigure { config, .. } => {
                assert_eq!(config.width, 1280);
                assert_eq!(config.frame_rate_numerator, 60000);
                assert_eq!(config.frame_rate_denominator, 1001);
                assert_eq!(config.ndi_source_name, "GrapiX Program");
            }
            other => panic!("expected OutputConfigure, got {other:?}"),
        }
    }

    #[test]
    fn parses_bare_control_messages() {
        for (raw, expected) in [
            (
                r#"{"type":"output.start","protocolVersion":1}"#,
                "output.start",
            ),
            (
                r#"{"type":"output.stop","protocolVersion":1}"#,
                "output.stop",
            ),
            (r#"{"type":"status","protocolVersion":1}"#, "status"),
        ] {
            let message = parse_client_message(raw).expect("control message must parse");
            assert_eq!(message.message_type(), expected);
        }
    }

    #[test]
    fn rejects_invalid_json() {
        let error = parse_client_message("not json").unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidJson);
    }

    #[test]
    fn rejects_missing_protocol_version() {
        let error = parse_client_message(r#"{"type":"status"}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
    }

    #[test]
    fn rejects_future_protocol_version() {
        let error = parse_client_message(r#"{"type":"status","protocolVersion":2}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
    }

    #[test]
    fn rejects_unknown_type_with_request_id_echo() {
        let error = parse_client_message(
            r#"{"type":"scene.explode","protocolVersion":1,"requestId":"req_9"}"#,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedMessage);
        assert_eq!(error.request_id.as_deref(), Some("req_9"));
    }

    #[test]
    fn rejects_scene_load_without_scene() {
        let error =
            parse_client_message(r#"{"type":"scene.load","protocolVersion":1}"#).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPayload);
    }

    #[test]
    fn ack_serializes_camel_case_envelope() {
        let json = ServerMessage::ack("scene.load", Some("req_1".into()), vec!["warning".into()])
            .to_json();
        assert!(json.contains(r#""type":"ack""#));
        assert!(json.contains(r#""protocolVersion":1"#));
        assert!(json.contains(r#""requestType":"scene.load""#));
        assert!(json.contains(r#""requestId":"req_1""#));
    }
}
