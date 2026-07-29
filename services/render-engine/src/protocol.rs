//! Render engine protocol v3, Rust side.
//!
//! Mirrors `@grapix/render-protocol`. The two must change in the same commit —
//! this is the same discipline the existing daemon has with protocol v2, and for
//! the same reason: a client and an engine that disagree about the wire format
//! fail at connection time in the best case and mid-show in the worst.
//!
//! Retained from v2: a version, a request id, a strictly increasing per-connection
//! sequence, a timestamp, and explicit nullability. Added: `message_id` for
//! duplicate suppression, `engine_id` for multi-engine routing, `project_id` for
//! permission scoping, and `requires_ack` stated rather than inferred.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 3;

/// Every message, in both directions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    /// Unique per message. A retransmit reuses it; a new message never does.
    #[serde(rename = "messageId")]
    pub message_id: String,
    /// Correlates a reply to its request. Null on unsolicited events.
    #[serde(rename = "requestId")]
    pub request_id: Option<String>,
    #[serde(rename = "engineId")]
    pub engine_id: Option<String>,
    /// Permission scope. Null for connection-level messages.
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(rename = "sceneId")]
    pub scene_id: Option<String>,
    #[serde(rename = "sceneRevision")]
    pub scene_revision: Option<u64>,
    #[serde(rename = "timestampMs")]
    pub timestamp_ms: u64,
    #[serde(rename = "type")]
    pub message_type: String,
    #[serde(rename = "requiresAck")]
    pub requires_ack: bool,
    /// Strictly increasing per connection, per direction.
    pub sequence: u64,
    pub direction: String,
    pub payload: Value,
}

impl Envelope {
    /// Prefix distinguishing a correlated reply from an unsolicited event.
    ///
    /// Replies and events are numbered by *separate* counters — the connection's
    /// outbound sequence and the engine's event sequence — so without a prefix the
    /// first of each would both be `<engine>-1`. A client's duplicate suppression
    /// would then drop one of them, which is exactly the kind of fault that only
    /// appears once events start interleaving with replies.
    const REPLY_PREFIX: char = 'r';
    const EVENT_PREFIX: char = 'e';

    pub fn reply(
        message_type: &str,
        payload: Value,
        request_id: Option<String>,
        engine_id: &str,
        sequence: u64,
        timestamp_ms: u64,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            message_id: format!("{engine_id}-{}{sequence}", Self::REPLY_PREFIX),
            request_id,
            engine_id: Some(engine_id.to_string()),
            project_id: None,
            scene_id: None,
            scene_revision: None,
            timestamp_ms,
            message_type: message_type.to_string(),
            requires_ack: false,
            sequence,
            direction: "engine-to-client".to_string(),
            payload,
        }
    }

    pub fn event(
        event_type: &str,
        payload: Value,
        engine_id: &str,
        sequence: u64,
        timestamp_ms: u64,
    ) -> Self {
        let mut envelope =
            Self::reply(event_type, payload, None, engine_id, sequence, timestamp_ms);
        // Re-key into the event namespace so an event can never collide with a
        // reply that happens to carry the same number.
        envelope.message_id = format!("{engine_id}-{}{sequence}", Self::EVENT_PREFIX);
        envelope
    }
}

/// Error codes. Kept in step with the TypeScript union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidJson,
    ProtocolVersionMismatch,
    InvalidEnvelope,
    InvalidPayload,
    UnsupportedMessage,
    Unauthenticated,
    Unauthorized,
    ProjectNotPermitted,
    DuplicateMessage,
    StaleSequence,
    SequenceGap,
    RevisionMismatch,
    ResyncRequired,
    SceneNotFound,
    SceneNotPrepared,
    StageNotFound,
    StageUnsupported,
    AssetNotFound,
    AssetRejected,
    PathNotPermitted,
    MessageTooLarge,
    UploadTooLarge,
    RateLimited,
    PreviewTooLarge,
    CapabilityUnsupported,
    OutputError,
    DeviceLost,
    EngineBusy,
    InternalError,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::InvalidJson => "INVALID_JSON",
            ErrorCode::ProtocolVersionMismatch => "PROTOCOL_VERSION_MISMATCH",
            ErrorCode::InvalidEnvelope => "INVALID_ENVELOPE",
            ErrorCode::InvalidPayload => "INVALID_PAYLOAD",
            ErrorCode::UnsupportedMessage => "UNSUPPORTED_MESSAGE",
            ErrorCode::Unauthenticated => "UNAUTHENTICATED",
            ErrorCode::Unauthorized => "UNAUTHORIZED",
            ErrorCode::ProjectNotPermitted => "PROJECT_NOT_PERMITTED",
            ErrorCode::DuplicateMessage => "DUPLICATE_MESSAGE",
            ErrorCode::StaleSequence => "STALE_SEQUENCE",
            ErrorCode::SequenceGap => "SEQUENCE_GAP",
            ErrorCode::RevisionMismatch => "REVISION_MISMATCH",
            ErrorCode::ResyncRequired => "RESYNC_REQUIRED",
            ErrorCode::SceneNotFound => "SCENE_NOT_FOUND",
            ErrorCode::SceneNotPrepared => "SCENE_NOT_PREPARED",
            ErrorCode::StageNotFound => "STAGE_NOT_FOUND",
            ErrorCode::StageUnsupported => "STAGE_UNSUPPORTED",
            ErrorCode::AssetNotFound => "ASSET_NOT_FOUND",
            ErrorCode::AssetRejected => "ASSET_REJECTED",
            ErrorCode::PathNotPermitted => "PATH_NOT_PERMITTED",
            ErrorCode::MessageTooLarge => "MESSAGE_TOO_LARGE",
            ErrorCode::UploadTooLarge => "UPLOAD_TOO_LARGE",
            ErrorCode::RateLimited => "RATE_LIMITED",
            ErrorCode::PreviewTooLarge => "PREVIEW_TOO_LARGE",
            ErrorCode::CapabilityUnsupported => "CAPABILITY_UNSUPPORTED",
            ErrorCode::OutputError => "OUTPUT_ERROR",
            ErrorCode::DeviceLost => "DEVICE_LOST",
            ErrorCode::EngineBusy => "ENGINE_BUSY",
            ErrorCode::InternalError => "INTERNAL_ERROR",
        }
    }

    /// Whether the client may retry the same message unchanged.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            ErrorCode::RateLimited
                | ErrorCode::EngineBusy
                | ErrorCode::SceneNotPrepared
                | ErrorCode::InternalError
        )
    }

    /// Whether the client must full-sync before continuing.
    pub fn requires_full_sync(&self) -> bool {
        matches!(
            self,
            ErrorCode::RevisionMismatch | ErrorCode::ResyncRequired | ErrorCode::SequenceGap
        )
    }
}

#[derive(Debug, Clone)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn to_payload(&self) -> Value {
        serde_json::json!({
            "code": self.code.as_str(),
            "message": self.message,
            "retryable": self.code.retryable(),
            "requiresFullSync": self.code.requires_full_sync(),
        })
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ProtocolError {}

/// Message types the engine accepts.
///
/// Exhaustive rather than string-matched at each call site, so adding a message to
/// the protocol forces every handler to acknowledge it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestType {
    // Connection
    Hello,
    Authenticate,
    Heartbeat,
    Capabilities,
    Disconnect,
    // Stage
    StageLoad,
    StageUnload,
    // Scene
    SceneLoad,
    SceneUnload,
    SceneFullSync,
    SceneApplyPatch,
    SceneValidate,
    ScenePrepare,
    // Assets
    AssetRegister,
    AssetUpload,
    AssetValidate,
    AssetPreload,
    AssetRelease,
    // Playout
    Cue,
    TakeOnline,
    TakeOffline,
    Continue,
    Update,
    Stop,
    Clear,
    Replace,
    Transition,
    // Preview
    PreviewRequest,
    PreviewStreamStart,
    PreviewStreamStop,
    PreviewSetViewport,
    // Engine control
    GetStatus,
    GetDiagnostics,
    GetCapabilities,
    SetConfiguration,
    RestartRenderer,
    // Outputs
    OutputList,
    OutputConfigure,
    OutputStart,
    OutputStop,
    OutputRemove,
}

impl RequestType {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "connection.hello" => RequestType::Hello,
            "connection.authenticate" => RequestType::Authenticate,
            "connection.heartbeat" => RequestType::Heartbeat,
            "connection.capabilities" => RequestType::Capabilities,
            "connection.disconnect" => RequestType::Disconnect,
            "stage.load" => RequestType::StageLoad,
            "stage.unload" => RequestType::StageUnload,
            "scene.load" => RequestType::SceneLoad,
            "scene.unload" => RequestType::SceneUnload,
            "scene.fullSync" => RequestType::SceneFullSync,
            "scene.applyPatch" => RequestType::SceneApplyPatch,
            "scene.validate" => RequestType::SceneValidate,
            "scene.prepare" => RequestType::ScenePrepare,
            "asset.register" => RequestType::AssetRegister,
            "asset.upload" => RequestType::AssetUpload,
            "asset.validate" => RequestType::AssetValidate,
            "asset.preload" => RequestType::AssetPreload,
            "asset.release" => RequestType::AssetRelease,
            "playout.cue" => RequestType::Cue,
            "playout.takeOnline" => RequestType::TakeOnline,
            "playout.takeOffline" => RequestType::TakeOffline,
            "playout.continue" => RequestType::Continue,
            "playout.update" => RequestType::Update,
            "playout.stop" => RequestType::Stop,
            "playout.clear" => RequestType::Clear,
            "playout.replace" => RequestType::Replace,
            "playout.transition" => RequestType::Transition,
            "preview.request" => RequestType::PreviewRequest,
            "preview.streamStart" => RequestType::PreviewStreamStart,
            "preview.streamStop" => RequestType::PreviewStreamStop,
            "preview.setViewport" => RequestType::PreviewSetViewport,
            "engine.getStatus" => RequestType::GetStatus,
            "engine.getDiagnostics" => RequestType::GetDiagnostics,
            "engine.getCapabilities" => RequestType::GetCapabilities,
            "engine.setConfiguration" => RequestType::SetConfiguration,
            "engine.restartRenderer" => RequestType::RestartRenderer,
            "output.list" => RequestType::OutputList,
            "output.configure" => RequestType::OutputConfigure,
            "output.start" => RequestType::OutputStart,
            "output.stop" => RequestType::OutputStop,
            "output.remove" => RequestType::OutputRemove,
            _ => return None,
        })
    }

    /// Group, for rate limiting and audit logging.
    pub fn group(&self) -> &'static str {
        use RequestType::*;
        match self {
            Hello | Authenticate | Heartbeat | Capabilities | Disconnect => "connection",
            StageLoad | StageUnload => "stage",
            SceneLoad | SceneUnload | SceneFullSync | SceneApplyPatch | SceneValidate
            | ScenePrepare => "scene",
            AssetRegister | AssetUpload | AssetValidate | AssetPreload | AssetRelease => "asset",
            Cue | TakeOnline | TakeOffline | Continue | Update | Stop | Clear | Replace
            | Transition => "playout",
            PreviewRequest | PreviewStreamStart | PreviewStreamStop | PreviewSetViewport => {
                "preview"
            }
            GetStatus | GetDiagnostics | GetCapabilities | SetConfiguration | RestartRenderer => {
                "engine"
            }
            OutputList | OutputConfigure | OutputStart | OutputStop | OutputRemove => "output"
        }
    }

    /// Whether this message may be sent before authenticating.
    ///
    /// Only the handshake itself. Everything else is refused until the client has
    /// presented a token.
    pub fn allowed_unauthenticated(&self) -> bool {
        matches!(
            self,
            RequestType::Hello | RequestType::Authenticate | RequestType::Disconnect
        )
    }

    /// Whether this message changes engine state and belongs in the audit log.
    pub fn is_state_changing(&self) -> bool {
        !matches!(
            self,
            RequestType::Heartbeat
                | RequestType::Capabilities
                | RequestType::GetStatus
                | RequestType::GetDiagnostics
                | RequestType::GetCapabilities
                | RequestType::PreviewRequest
                | RequestType::SceneValidate
                | RequestType::AssetValidate
                | RequestType::OutputList
        )
    }

    /// Rate-limit cost.
    ///
    /// Previews and uploads are the expensive ones, and they are the ones a
    /// runaway client loops on.
    pub fn rate_cost(&self) -> f64 {
        match self {
            RequestType::PreviewRequest => 4.0,
            RequestType::AssetUpload => 2.0,
            RequestType::SceneLoad | RequestType::SceneFullSync => 4.0,
            RequestType::GetDiagnostics => 2.0,
            RequestType::Heartbeat => 0.0,
            _ => 1.0,
        }
    }
}

/// Decode and validate a frame.
///
/// `max_bytes` is enforced before parsing so an unbounded frame from a remote
/// client cannot be a denial of service against a live renderer.
pub fn decode(raw: &str, max_bytes: u64) -> Result<Envelope, ProtocolError> {
    if raw.len() as u64 > max_bytes {
        return Err(ProtocolError::new(
            ErrorCode::MessageTooLarge,
            format!("message is {} bytes; limit is {max_bytes}", raw.len()),
        ));
    }

    let value: Value = serde_json::from_str(raw)
        .map_err(|error| ProtocolError::new(ErrorCode::InvalidJson, error.to_string()))?;

    let version = value.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(u64::from(PROTOCOL_VERSION)) {
        return Err(ProtocolError::new(
            ErrorCode::ProtocolVersionMismatch,
            format!(
                "expected protocol version {PROTOCOL_VERSION}, received {}",
                version.map(|v| v.to_string()).unwrap_or_else(|| "none".to_string())
            ),
        ));
    }

    let envelope: Envelope = serde_json::from_value(value)
        .map_err(|error| ProtocolError::new(ErrorCode::InvalidEnvelope, error.to_string()))?;

    if envelope.message_id.trim().is_empty() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidEnvelope,
            "messageId must be a non-empty string",
        ));
    }
    if envelope.sequence == 0 {
        return Err(ProtocolError::new(
            ErrorCode::InvalidEnvelope,
            "sequence must be a positive integer",
        ));
    }
    if RequestType::parse(&envelope.message_type).is_none() {
        return Err(ProtocolError::new(
            ErrorCode::UnsupportedMessage,
            format!("unknown message type {}", envelope.message_type),
        ));
    }

    Ok(envelope)
}

pub fn encode(envelope: &Envelope) -> Result<String, ProtocolError> {
    serde_json::to_string(envelope)
        .map_err(|error| ProtocolError::new(ErrorCode::InternalError, error.to_string()))
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
