//! Versioned control protocol between GrapiX controllers and the render
//! daemon.
//!
//! Protocol v2 uses JSON text frames over the existing authenticated local
//! WebSocket transport. Every command has a mandatory correlation and safety
//! envelope. The transport rejects replayed/out-of-order sequence numbers;
//! scene commands additionally prove the scene id and revision carried by the
//! payload. This keeps the wire semantics safe while named-pipe/gRPC transport
//! work remains a later deployment choice.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::OutputConfigMessage;

pub const PROTOCOL_VERSION: u64 = 2;

pub const SUPPORTED_COMMANDS: &[&str] = &[
    "capabilities.get",
    "heartbeat",
    "scene.load",
    "scene.update",
    "scene.warm",
    "scene.patch",
    "scene.release",
    "channel.preview.set",
    "channel.take",
    "resource.profile.set",
    "output.configure",
    "output.start",
    "output.stop",
    "status",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExpectedRendererState {
    Any,
    Idle,
    Configured,
    Running,
}

impl ExpectedRendererState {
    pub fn as_str(self) -> &'static str {
        match self {
            ExpectedRendererState::Any => "any",
            ExpectedRendererState::Idle => "idle",
            ExpectedRendererState::Configured => "configured",
            ExpectedRendererState::Running => "running",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererChannel {
    Preview,
    Program,
}

#[derive(Debug, Clone)]
pub struct CommandMetadata {
    pub request_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub expected_renderer_state: ExpectedRendererState,
    pub scene_id: Option<String>,
    pub scene_revision: Option<String>,
    pub channel: Option<RendererChannel>,
}

/// Messages a controller sends to the daemon.
#[derive(Debug)]
pub enum ClientMessage {
    Capabilities {
        metadata: CommandMetadata,
    },
    Heartbeat {
        metadata: CommandMetadata,
    },
    /// Replace the current scene with a full `SceneDocument`.
    SceneLoad {
        metadata: CommandMetadata,
        scene: Value,
    },
    /// Full replacement for structural edits. High-frequency data/property
    /// changes use ScenePatch below.
    SceneUpdate {
        metadata: CommandMetadata,
        scene: Value,
    },
    SceneWarm {
        metadata: CommandMetadata,
        scene: Value,
    },
    ScenePatch {
        metadata: CommandMetadata,
        patch: ScenePatch,
        next_scene_revision: String,
    },
    SceneRelease {
        metadata: CommandMetadata,
    },
    SetPreview {
        metadata: CommandMetadata,
    },
    Take {
        metadata: CommandMetadata,
    },
    SetResourceProfile {
        metadata: CommandMetadata,
        profile: crate::resource::QualityProfile,
    },
    OutputConfigure {
        metadata: CommandMetadata,
        config: OutputConfigMessage,
    },
    OutputStart {
        metadata: CommandMetadata,
    },
    OutputStop {
        metadata: CommandMetadata,
    },
    Status {
        metadata: CommandMetadata,
    },
}

impl ClientMessage {
    pub fn metadata(&self) -> &CommandMetadata {
        match self {
            ClientMessage::Capabilities { metadata }
            | ClientMessage::Heartbeat { metadata }
            | ClientMessage::SceneLoad { metadata, .. }
            | ClientMessage::SceneUpdate { metadata, .. }
            | ClientMessage::SceneWarm { metadata, .. }
            | ClientMessage::ScenePatch { metadata, .. }
            | ClientMessage::SceneRelease { metadata }
            | ClientMessage::SetPreview { metadata }
            | ClientMessage::Take { metadata }
            | ClientMessage::SetResourceProfile { metadata, .. }
            | ClientMessage::OutputConfigure { metadata, .. }
            | ClientMessage::OutputStart { metadata }
            | ClientMessage::OutputStop { metadata }
            | ClientMessage::Status { metadata } => metadata,
        }
    }

    pub fn request_id(&self) -> &str {
        &self.metadata().request_id
    }

    pub fn sequence(&self) -> u64 {
        self.metadata().sequence
    }

    pub fn expected_renderer_state(&self) -> ExpectedRendererState {
        self.metadata().expected_renderer_state
    }

    pub fn message_type(&self) -> &'static str {
        match self {
            ClientMessage::Capabilities { .. } => "capabilities.get",
            ClientMessage::Heartbeat { .. } => "heartbeat",
            ClientMessage::SceneLoad { .. } => "scene.load",
            ClientMessage::SceneUpdate { .. } => "scene.update",
            ClientMessage::SceneWarm { .. } => "scene.warm",
            ClientMessage::ScenePatch { .. } => "scene.patch",
            ClientMessage::SceneRelease { .. } => "scene.release",
            ClientMessage::SetPreview { .. } => "channel.preview.set",
            ClientMessage::Take { .. } => "channel.take",
            ClientMessage::SetResourceProfile { .. } => "resource.profile.set",
            ClientMessage::OutputConfigure { .. } => "output.configure",
            ClientMessage::OutputStart { .. } => "output.start",
            ClientMessage::OutputStop { .. } => "output.stop",
            ClientMessage::Status { .. } => "status",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ScenePatch {
    #[serde(rename = "PATCH_DATA_CONTEXT")]
    DataContext {
        #[serde(rename = "sceneId")]
        scene_id: String,
        path: String,
        value: Value,
    },
    #[serde(rename = "PATCH_SCENE_PROPERTY")]
    SceneProperty {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "objectId")]
        object_id: String,
        property: String,
        value: Value,
    },
    #[serde(rename = "SET_VISIBILITY")]
    Visibility {
        #[serde(rename = "sceneId")]
        scene_id: String,
        #[serde(rename = "objectId")]
        object_id: String,
        value: bool,
    },
}

impl ScenePatch {
    pub fn scene_id(&self) -> &str {
        match self {
            Self::DataContext { scene_id, .. }
            | Self::SceneProperty { scene_id, .. }
            | Self::Visibility { scene_id, .. } => scene_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidJson,
    ProtocolVersionMismatch,
    InvalidEnvelope,
    StaleSequence,
    RevisionMismatch,
    ExpectedStateMismatch,
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
    pub sequence: Option<u64>,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            request_id: None,
            sequence: None,
        }
    }

    pub fn with_request_id(mut self, request_id: Option<String>) -> Self {
        self.request_id = request_id;
        self
    }

    pub fn with_sequence(mut self, sequence: Option<u64>) -> Self {
        self.sequence = sequence;
        self
    }

    pub fn with_metadata(mut self, metadata: &CommandMetadata) -> Self {
        self.request_id = Some(metadata.request_id.clone());
        self.sequence = Some(metadata.sequence);
        self
    }
}

/// Parse one incoming text frame and validate its complete v2 envelope.
pub fn parse_client_message(text: &str) -> Result<ClientMessage, ProtocolError> {
    let value: Value = serde_json::from_str(text).map_err(|error| {
        ProtocolError::new(
            ErrorCode::InvalidJson,
            format!("message is not valid JSON: {error}"),
        )
    })?;

    if !value.is_object() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidJson,
            "message must be a JSON object",
        ));
    }

    let request_id_context = value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let sequence_context = value.get("sequence").and_then(Value::as_u64);

    let version = value.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(PROTOCOL_VERSION) {
        return Err(contextual_error(
            ErrorCode::ProtocolVersionMismatch,
            format!(
                "expected protocolVersion {PROTOCOL_VERSION}, got {}",
                version.map_or_else(|| "none".to_string(), |v| v.to_string())
            ),
            request_id_context,
            sequence_context,
        ));
    }

    let metadata = parse_metadata(&value)?;
    let message_type = required_string(&value, "type", &metadata)?;

    match message_type.as_str() {
        "capabilities.get" => Ok(ClientMessage::Capabilities { metadata }),
        "heartbeat" => Ok(ClientMessage::Heartbeat { metadata }),
        "scene.load" | "scene.update" | "scene.warm" => {
            let scene = value
                .get("scene")
                .cloned()
                .filter(Value::is_object)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, "missing object field \"scene\"")
                        .with_metadata(&metadata)
                })?;

            validate_scene_envelope(&scene, &metadata)?;
            match message_type.as_str() {
                "scene.load" => Ok(ClientMessage::SceneLoad { metadata, scene }),
                "scene.update" => Ok(ClientMessage::SceneUpdate { metadata, scene }),
                "scene.warm" => Ok(ClientMessage::SceneWarm { metadata, scene }),
                _ => unreachable!("matched scene command"),
            }
        }
        "scene.patch" => {
            validate_scoped_command(&metadata, None)?;
            let patch: ScenePatch = value
                .get("patch")
                .cloned()
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, "patch is required")
                        .with_metadata(&metadata)
                })
                .and_then(|raw| {
                    serde_json::from_value(raw).map_err(|error| {
                        ProtocolError::new(
                            ErrorCode::InvalidPayload,
                            format!("invalid scene patch: {error}"),
                        )
                        .with_metadata(&metadata)
                    })
                })?;
            if Some(patch.scene_id()) != metadata.scene_id.as_deref() {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidEnvelope,
                    "patch sceneId does not match envelope sceneId",
                )
                .with_metadata(&metadata));
            }
            let next_scene_revision = required_string(&value, "nextSceneRevision", &metadata)?;
            if metadata.scene_revision.as_deref() == Some(next_scene_revision.as_str()) {
                return Err(ProtocolError::new(
                    ErrorCode::RevisionMismatch,
                    "nextSceneRevision must differ from the current sceneRevision",
                )
                .with_metadata(&metadata));
            }
            Ok(ClientMessage::ScenePatch {
                metadata,
                patch,
                next_scene_revision,
            })
        }
        "scene.release" => {
            validate_scoped_command(&metadata, None)?;
            Ok(ClientMessage::SceneRelease { metadata })
        }
        "channel.preview.set" => {
            validate_scoped_command(&metadata, Some(RendererChannel::Preview))?;
            Ok(ClientMessage::SetPreview { metadata })
        }
        "channel.take" => {
            validate_scoped_command(&metadata, Some(RendererChannel::Program))?;
            let transition = value
                .get("transition")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if transition != "cut" {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    "protocol v2 implements only transition \"cut\"",
                )
                .with_metadata(&metadata));
            }
            Ok(ClientMessage::Take { metadata })
        }
        "resource.profile.set" => {
            let profile = value
                .get("profile")
                .cloned()
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidPayload, "profile is required")
                        .with_metadata(&metadata)
                })
                .and_then(|raw| {
                    serde_json::from_value(raw).map_err(|_| {
                        ProtocolError::new(
                            ErrorCode::InvalidPayload,
                            "profile must be EDITOR_PREVIEW, PROGRAM_HD, PROGRAM_UHD, LOW_LATENCY, or SAFE_MODE",
                        )
                        .with_metadata(&metadata)
                    })
                })?;
            Ok(ClientMessage::SetResourceProfile { metadata, profile })
        }
        "output.configure" => {
            let config: OutputConfigMessage =
                serde_json::from_value(value.clone()).map_err(|error| {
                    ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        format!("invalid output.configure payload: {error}"),
                    )
                    .with_metadata(&metadata)
                })?;
            Ok(ClientMessage::OutputConfigure { metadata, config })
        }
        "output.start" => Ok(ClientMessage::OutputStart { metadata }),
        "output.stop" => Ok(ClientMessage::OutputStop { metadata }),
        "status" => Ok(ClientMessage::Status { metadata }),
        other => Err(ProtocolError::new(
            ErrorCode::UnsupportedMessage,
            format!("unknown message type {other:?}"),
        )
        .with_metadata(&metadata)),
    }
}

fn parse_metadata(value: &Value) -> Result<CommandMetadata, ProtocolError> {
    let request_id = value
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidEnvelope,
                "requestId must be a non-empty string",
            )
        })?;

    let sequence = value
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|sequence| *sequence > 0)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidEnvelope,
                "sequence must be a positive integer",
            )
            .with_request_id(Some(request_id.clone()))
        })?;

    let timestamp_ms = value
        .get("timestampMs")
        .and_then(Value::as_u64)
        .filter(|timestamp| *timestamp > 0)
        .ok_or_else(|| {
            contextual_error(
                ErrorCode::InvalidEnvelope,
                "timestampMs must be a positive integer",
                Some(request_id.clone()),
                Some(sequence),
            )
        })?;

    let expected_renderer_state: ExpectedRendererState = value
        .get("expectedRendererState")
        .cloned()
        .ok_or_else(|| {
            contextual_error(
                ErrorCode::InvalidEnvelope,
                "expectedRendererState is required",
                Some(request_id.clone()),
                Some(sequence),
            )
        })
        .and_then(|raw| {
            serde_json::from_value(raw).map_err(|_| {
                contextual_error(
                    ErrorCode::InvalidEnvelope,
                    "expectedRendererState must be any, idle, configured, or running",
                    Some(request_id.clone()),
                    Some(sequence),
                )
            })
        })?;

    let scene_id = nullable_string(value, "sceneId", &request_id, sequence)?;
    let scene_revision = nullable_string(value, "sceneRevision", &request_id, sequence)?;
    let channel = nullable_channel(value, &request_id, sequence)?;

    Ok(CommandMetadata {
        request_id,
        sequence,
        timestamp_ms,
        expected_renderer_state,
        scene_id,
        scene_revision,
        channel,
    })
}

fn required_string(
    value: &Value,
    field: &str,
    metadata: &CommandMetadata,
) -> Result<String, ProtocolError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidEnvelope,
                format!("{field} must be a non-empty string"),
            )
            .with_metadata(metadata)
        })
}

fn nullable_string(
    value: &Value,
    field: &str,
    request_id: &str,
    sequence: u64,
) -> Result<Option<String>, ProtocolError> {
    match value.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text.clone())),
        Some(_) => Err(contextual_error(
            ErrorCode::InvalidEnvelope,
            format!("{field} must be a non-empty string or null"),
            Some(request_id.to_string()),
            Some(sequence),
        )),
        None => Err(contextual_error(
            ErrorCode::InvalidEnvelope,
            format!("{field} is required (use null when not applicable)"),
            Some(request_id.to_string()),
            Some(sequence),
        )),
    }
}

fn nullable_channel(
    value: &Value,
    request_id: &str,
    sequence: u64,
) -> Result<Option<RendererChannel>, ProtocolError> {
    match value.get("channel") {
        Some(Value::Null) => Ok(None),
        Some(raw @ Value::String(_)) => {
            serde_json::from_value(raw.clone()).map(Some).map_err(|_| {
                contextual_error(
                    ErrorCode::InvalidEnvelope,
                    "channel must be preview, program, or null",
                    Some(request_id.to_string()),
                    Some(sequence),
                )
            })
        }
        Some(_) => Err(contextual_error(
            ErrorCode::InvalidEnvelope,
            "channel must be preview, program, or null",
            Some(request_id.to_string()),
            Some(sequence),
        )),
        None => Err(contextual_error(
            ErrorCode::InvalidEnvelope,
            "channel is required (use null when not applicable)",
            Some(request_id.to_string()),
            Some(sequence),
        )),
    }
}

fn validate_scene_envelope(scene: &Value, metadata: &CommandMetadata) -> Result<(), ProtocolError> {
    let payload_scene_id = scene.get("id").and_then(Value::as_str).unwrap_or_default();
    let envelope_scene_id = metadata.scene_id.as_deref().unwrap_or_default();

    if payload_scene_id.is_empty() || payload_scene_id != envelope_scene_id {
        return Err(ProtocolError::new(
            ErrorCode::InvalidEnvelope,
            format!(
                "sceneId {:?} does not match payload scene id {:?}",
                metadata.scene_id, payload_scene_id
            ),
        )
        .with_metadata(metadata));
    }

    let payload_revision = scene
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let envelope_revision = metadata.scene_revision.as_deref().unwrap_or_default();
    if payload_revision.is_empty() || payload_revision != envelope_revision {
        return Err(ProtocolError::new(
            ErrorCode::RevisionMismatch,
            format!(
                "sceneRevision {:?} does not match payload updatedAt {:?}",
                metadata.scene_revision, payload_revision
            ),
        )
        .with_metadata(metadata));
    }

    Ok(())
}

fn validate_scoped_command(
    metadata: &CommandMetadata,
    expected_channel: Option<RendererChannel>,
) -> Result<(), ProtocolError> {
    if metadata.scene_id.is_none() || metadata.scene_revision.is_none() {
        return Err(ProtocolError::new(
            ErrorCode::InvalidEnvelope,
            "sceneId and sceneRevision are required for scene-scoped commands",
        )
        .with_metadata(metadata));
    }
    if metadata.channel != expected_channel {
        return Err(ProtocolError::new(
            ErrorCode::InvalidEnvelope,
            format!(
                "command requires channel {:?}, got {:?}",
                expected_channel, metadata.channel
            ),
        )
        .with_metadata(metadata));
    }
    Ok(())
}

fn contextual_error(
    code: ErrorCode,
    message: impl Into<String>,
    request_id: Option<String>,
    sequence: Option<u64>,
) -> ProtocolError {
    ProtocolError::new(code, message)
        .with_request_id(request_id)
        .with_sequence(sequence)
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
        request_id: String,
        sequence: u64,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        sequence: Option<u64>,
    },
    #[serde(rename = "status")]
    Status {
        protocol_version: u64,
        request_id: String,
        sequence: u64,
        #[serde(flatten)]
        report: Box<StatusReport>,
    },
    #[serde(rename = "capabilities")]
    Capabilities {
        protocol_version: u64,
        request_id: String,
        sequence: u64,
        capabilities: RendererCapabilities,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererEvent {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub protocol_version: u64,
    pub event_type: String,
    pub event_sequence: u64,
    pub timestamp_ms: u64,
    pub payload: Value,
}

impl RendererEvent {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("renderer events contain serializable fields")
    }
}

impl ServerMessage {
    pub fn ack(
        request_type: &str,
        request_id: String,
        sequence: u64,
        warnings: Vec<String>,
    ) -> Self {
        ServerMessage::Ack {
            protocol_version: PROTOCOL_VERSION,
            request_type: request_type.to_string(),
            request_id,
            sequence,
            warnings,
        }
    }

    pub fn error(error: ProtocolError) -> Self {
        ServerMessage::Error {
            protocol_version: PROTOCOL_VERSION,
            code: error.code,
            message: error.message,
            request_id: error.request_id,
            sequence: error.sequence,
        }
    }

    pub fn status(request_id: String, sequence: u64, report: StatusReport) -> Self {
        ServerMessage::Status {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            sequence,
            report: Box::new(report),
        }
    }

    pub fn capabilities(request_id: String, sequence: u64) -> Self {
        ServerMessage::Capabilities {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            sequence,
            capabilities: RendererCapabilities::current(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server messages contain only serializable fields")
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererCapabilities {
    pub protocol_version: u64,
    pub scene_document_versions: Vec<u64>,
    pub transport: String,
    pub commands: Vec<String>,
    pub max_warm_scenes: usize,
    pub preview_program_channels: bool,
    pub scene_patching: bool,
    pub rendered_object_types: Vec<String>,
    pub output_backends: Vec<String>,
    pub supported_transitions: Vec<String>,
    pub native_text_render: bool,
    pub packaged_font_files: bool,
    pub remote_font_css: bool,
    pub scene_automation_execution: bool,
    pub scene_script_execution: bool,
    pub media_lifecycle: bool,
    pub native_video_decode: bool,
    pub gltf_import_validation: bool,
    pub native_3d_render: bool,
    /// Whether authored scene cameras drive the Program view-projection.
    ///
    /// Describes only what is actually implemented: a static, unparented,
    /// unbound, visible camera. A parented, animated or data-bound camera is
    /// still refused with a Take-blocking diagnostic, so this flag does NOT
    /// promise full camera parity.
    pub native_active_camera: bool,
}

impl RendererCapabilities {
    fn current() -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            scene_document_versions: vec![1],
            transport: "websocket".to_string(),
            commands: SUPPORTED_COMMANDS
                .iter()
                .map(|command| (*command).to_string())
                .collect(),
            max_warm_scenes: crate::scene::DEFAULT_MAX_WARM_SCENES,
            preview_program_channels: true,
            scene_patching: true,
            rendered_object_types: vec![
                "rect".to_string(),
                "ellipse".to_string(),
                "mesh".to_string(),
            ],
            output_backends: {
                let mut backends = vec!["null".to_string(), "recording".to_string()];
                if cfg!(feature = "ndi") {
                    backends.push("ndi".to_string());
                }
                backends
            },
            supported_transitions: vec!["cut".to_string()],
            native_text_render: false,
            packaged_font_files: false,
            remote_font_css: false,
            scene_automation_execution: false,
            scene_script_execution: false,
            media_lifecycle: true,
            native_video_decode: false,
            gltf_import_validation: true,
            native_3d_render: true,
            native_active_camera: true,
        }
    }
}

/// Diagnostics snapshot; serialized into `status` replies.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    pub connected_clients: usize,
    pub scene: Option<SceneStatus>,
    pub scenes: Vec<LifecycleSceneStatus>,
    pub program_scene_id: Option<String>,
    pub preview_scene_id: Option<String>,
    pub warm_scene_count: usize,
    pub max_warm_scenes: usize,
    pub estimated_cache_bytes: u64,
    pub asset_cache: crate::asset_cache::AssetCacheStatus,
    pub resources: ResourceStatus,
    pub gpu: GpuStatus,
    pub output: OutputStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceStatus {
    pub profile: crate::resource::QualityProfile,
    pub limits: crate::resource::ResourceLimits,
    pub cache_pressure: f64,
    pub over_budget: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneStatus {
    pub id: String,
    pub name: String,
    /// `SceneDocument.updatedAt` is the protocol v2 scene revision.
    pub revision: String,
    pub object_count: usize,
    pub rect_count: usize,
    pub mesh_count: usize,
    /// Typed report with stable codes and explicit severities. `warnings` and
    /// `take_blockers` remain as derived string views for older controllers.
    pub diagnostics: Vec<crate::scene::SceneDiagnostic>,
    pub warnings: Vec<String>,
    pub take_ready: bool,
    pub take_blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSceneStatus {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub lifecycle: crate::scene::SceneLifecycle,
    pub object_count: usize,
    pub rect_count: usize,
    pub mesh_count: usize,
    pub diagnostics: Vec<crate::scene::SceneDiagnostic>,
    pub warnings: Vec<String>,
    pub take_ready: bool,
    pub take_blockers: Vec<String>,
    pub estimated_bytes: u64,
    pub last_used: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStatus {
    pub adapter: String,
    pub backend: String,
    pub device_type: String,
    pub driver: String,
    pub driver_info: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub max_texture_dimension_2d: u32,
    pub max_buffer_size: u64,
    pub max_bind_groups: u32,
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
    pub timing_sample_count: usize,
    pub average_render_ms: f64,
    pub p99_render_ms: f64,
    pub frame_budget_ms: f64,
    pub average_budget_utilization: f64,
    pub p99_budget_utilization: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn command(message_type: &str) -> Value {
        json!({
            "type": message_type,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": "req_1",
            "sequence": 1,
            "timestampMs": 1_753_400_000_000_u64,
            "expectedRendererState": "any",
            "sceneId": null,
            "sceneRevision": null,
            "channel": null
        })
    }

    #[test]
    fn parses_scene_load_with_safe_envelope() {
        let mut value = command("scene.load");
        value["sceneId"] = json!("s1");
        value["sceneRevision"] = json!("2026-07-25T00:00:00.000Z");
        value["scene"] = json!({
            "id": "s1",
            "updatedAt": "2026-07-25T00:00:00.000Z"
        });

        let message = parse_client_message(&value.to_string()).expect("scene.load must parse");
        match message {
            ClientMessage::SceneLoad { metadata, scene } => {
                assert_eq!(metadata.request_id, "req_1");
                assert_eq!(metadata.sequence, 1);
                assert_eq!(scene.get("id").and_then(Value::as_str), Some("s1"));
            }
            other => panic!("expected SceneLoad, got {other:?}"),
        }
    }

    #[test]
    fn rejects_scene_revision_mismatch() {
        let mut value = command("scene.load");
        value["sceneId"] = json!("s1");
        value["sceneRevision"] = json!("revision_a");
        value["scene"] = json!({"id": "s1", "updatedAt": "revision_b"});

        let error = parse_client_message(&value.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::RevisionMismatch);
        assert_eq!(error.sequence, Some(1));
    }

    #[test]
    fn parses_output_configure() {
        let mut value = command("output.configure");
        value["width"] = json!(1280);
        value["height"] = json!(720);
        value["frameRateNumerator"] = json!(60000);
        value["frameRateDenominator"] = json!(1001);
        value["ndiSourceName"] = json!("GrapiX Program");
        value["backend"] = json!("null");

        let message =
            parse_client_message(&value.to_string()).expect("output.configure must parse");
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
    fn parses_control_and_health_messages() {
        for expected in [
            "capabilities.get",
            "heartbeat",
            "output.start",
            "output.stop",
            "status",
        ] {
            let message = parse_client_message(&command(expected).to_string())
                .expect("control message must parse");
            assert_eq!(message.message_type(), expected);
        }
    }

    #[test]
    fn parses_resource_profile_change() {
        let mut value = command("resource.profile.set");
        value["profile"] = json!("SAFE_MODE");
        let message =
            parse_client_message(&value.to_string()).expect("resource profile must parse");
        assert!(matches!(
            message,
            ClientMessage::SetResourceProfile {
                profile: crate::resource::QualityProfile::SafeMode,
                ..
            }
        ));
    }

    #[test]
    fn parses_lifecycle_and_channel_commands() {
        let mut warm = command("scene.warm");
        warm["sceneId"] = json!("s1");
        warm["sceneRevision"] = json!("r1");
        warm["scene"] = json!({"id": "s1", "updatedAt": "r1"});
        assert!(matches!(
            parse_client_message(&warm.to_string()).expect("warm must parse"),
            ClientMessage::SceneWarm { .. }
        ));

        let mut preview = command("channel.preview.set");
        preview["sceneId"] = json!("s1");
        preview["sceneRevision"] = json!("r1");
        preview["channel"] = json!("preview");
        assert!(matches!(
            parse_client_message(&preview.to_string()).expect("preview must parse"),
            ClientMessage::SetPreview { .. }
        ));

        let mut take = command("channel.take");
        take["sceneId"] = json!("s1");
        take["sceneRevision"] = json!("r1");
        take["channel"] = json!("program");
        take["transition"] = json!("cut");
        assert!(matches!(
            parse_client_message(&take.to_string()).expect("take must parse"),
            ClientMessage::Take { .. }
        ));

        let mut release = command("scene.release");
        release["sceneId"] = json!("s1");
        release["sceneRevision"] = json!("r1");
        assert!(matches!(
            parse_client_message(&release.to_string()).expect("release must parse"),
            ClientMessage::SceneRelease { .. }
        ));
    }

    #[test]
    fn rejects_wrong_channel_and_unsupported_transition() {
        let mut preview = command("channel.preview.set");
        preview["sceneId"] = json!("s1");
        preview["sceneRevision"] = json!("r1");
        preview["channel"] = json!("program");
        let error = parse_client_message(&preview.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidEnvelope);

        let mut take = command("channel.take");
        take["sceneId"] = json!("s1");
        take["sceneRevision"] = json!("r1");
        take["channel"] = json!("program");
        take["transition"] = json!("mix");
        let error = parse_client_message(&take.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPayload);
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
        let mut value = command("status");
        value["protocolVersion"] = json!(PROTOCOL_VERSION + 1);
        let error = parse_client_message(&value.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::ProtocolVersionMismatch);
    }

    #[test]
    fn rejects_missing_sequence() {
        let mut value = command("status");
        value.as_object_mut().expect("object").remove("sequence");
        let error = parse_client_message(&value.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidEnvelope);
    }

    #[test]
    fn rejects_missing_nullable_scene_context() {
        let mut value = command("status");
        value.as_object_mut().expect("object").remove("sceneId");
        let error = parse_client_message(&value.to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidEnvelope);
    }

    #[test]
    fn rejects_unknown_type_with_context() {
        let error = parse_client_message(&command("scene.explode").to_string()).unwrap_err();
        assert_eq!(error.code, ErrorCode::UnsupportedMessage);
        assert_eq!(error.request_id.as_deref(), Some("req_1"));
        assert_eq!(error.sequence, Some(1));
    }

    #[test]
    fn ack_serializes_v2_envelope() {
        let json =
            ServerMessage::ack("scene.load", "req_1".into(), 7, vec!["warning".into()]).to_json();
        assert!(json.contains(r#""type":"ack""#));
        assert!(json.contains(r#""protocolVersion":2"#));
        assert!(json.contains(r#""requestType":"scene.load""#));
        assert!(json.contains(r#""requestId":"req_1""#));
        assert!(json.contains(r#""sequence":7"#));
    }

    #[test]
    fn capabilities_describe_only_implemented_features() {
        let json = ServerMessage::capabilities("req_1".into(), 1).to_json();
        assert!(json.contains(r#""type":"capabilities""#));
        assert!(json.contains(r#""maxWarmScenes":3"#));
        assert!(json.contains(r#""previewProgramChannels":true"#));
        assert!(json.contains(r#""scenePatching":true"#));
        assert!(json.contains(r#""supportedTransitions":["cut"]"#));
        assert!(json.contains(r#""nativeTextRender":false"#));
        assert!(json.contains(r#""packagedFontFiles":false"#));
        assert!(json.contains(r#""sceneAutomationExecution":false"#));
        assert!(json.contains(r#""sceneScriptExecution":false"#));
        assert!(json.contains(r#""renderedObjectTypes":["rect","ellipse","mesh"]"#));
        assert!(json.contains(r#""native3dRender":true"#));
    }

    #[test]
    fn parses_revision_safe_data_patch() {
        let mut value = command("scene.patch");
        value["sceneId"] = json!("s1");
        value["sceneRevision"] = json!("r1");
        value["nextSceneRevision"] = json!("r2");
        value["patch"] = json!({
            "type": "PATCH_DATA_CONTEXT",
            "sceneId": "s1",
            "path": "player.name",
            "value": "Vamsi"
        });
        assert!(matches!(
            parse_client_message(&value.to_string()).expect("patch must parse"),
            ClientMessage::ScenePatch {
                patch: ScenePatch::DataContext { .. },
                ..
            }
        ));
    }
}
