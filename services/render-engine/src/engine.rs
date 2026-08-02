//! The engine controller.
//!
//! One `Engine` owns all renderer state: loaded stages and scenes, tile managers,
//! the frame clock, Preview and Program selection, and the audit log. Every
//! protocol message is dispatched here, and nothing outside this module touches a
//! GPU resource.
//!
//! Two invariants the dispatch enforces:
//!
//! 1. **Program changes only through Playout commands.** `Cue` sets Preview;
//!    `TakeOnline` sets Program. A scene load can never put anything on air.
//! 2. **An unprepared scene does not go online** unless the operator sets
//!    `overrideUnprepared`, which is recorded in the audit log with a reason.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::broadcast;

use grapix_render_core::renderer::gpu::GpuContext;

use crate::capabilities::{
    ConnectionPrincipal, EngineCapabilities, EngineState, EngineStateMachine, OwnedBytes,
    ResourceGovernor, ResourcePriority, ScenePreparationEstimate,
};
use crate::config::EngineConfig;
use crate::outputs::{self, OutputFormat, OutputInstance, OutputStatus};
use crate::preview::{self, PreviewOutcome};
use crate::protocol::{now_ms, Envelope, ErrorCode, ProtocolError, RequestType, SceneRef};
use crate::render::TileSceneBuilder;
use crate::security::{AuditEntry, AuditLog};
use crate::stage::{Rect, StageDocument, TilingConfig};
use crate::tile::{FilterOverscan, TileGrid, TileManager, TileSelectionRequest};

/// Channels the engine renders independently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Preview,
    Program,
    Auxiliary,
}

impl Channel {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "preview" => Some(Channel::Preview),
            "program" => Some(Channel::Program),
            "auxiliary" => Some(Channel::Auxiliary),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Channel::Preview => "preview",
            Channel::Program => "program",
            Channel::Auxiliary => "auxiliary",
        }
    }
}

/// Preparation states from requirement 14.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparationState {
    NotLoaded,
    Loading,
    Ready,
    ReadyWithWarnings,
    Failed,
}

impl PreparationState {
    pub fn as_str(&self) -> &'static str {
        match self {
            PreparationState::NotLoaded => "not-loaded",
            PreparationState::Loading => "loading",
            PreparationState::Ready => "ready",
            PreparationState::ReadyWithWarnings => "ready-with-warnings",
            PreparationState::Failed => "failed",
        }
    }
}

/// One loaded scene and everything the engine holds for it.
pub struct LoadedScene {
    pub scene_id: String,
    pub name: String,
    pub revision: u64,
    pub stage_id: Option<String>,
    pub preparation: PreparationState,
    pub warnings: Vec<String>,
    pub take_blockers: Vec<String>,
    pub object_count: usize,
    pub tiles: TileManager,
    pub builder: TileSceneBuilder,
    pub frame: u64,
    pub prepared_tile_count: usize,
    pub last_used_ms: u64,
}

impl LoadedScene {
    /// The scene document as loaded, for a whole-region render pass.
    pub fn source_document(&self) -> &serde_json::Value {
        self.builder.source_document()
    }
}

/// Deterministic manifest-level estimate used before preparation can allocate
/// decoded/GPU resources. Precise post-upload accounting replaces this estimate
/// at commit; it is intentionally conservative for unknown asset metadata.
fn estimate_prepared_runtime(
    scene: &LoadedScene,
    priority: ResourcePriority,
    budget: crate::capabilities::ResourceBudget,
) -> ScenePreparationEstimate {
    let document_bytes = scene.source_document().to_string().len() as u64;
    let object_count = scene.object_count as u64;
    let per_scene_tile_budget = budget.gpu_bytes / u64::from(budget.resident_scene_target.max(1));
    ScenePreparationEstimate {
        priority,
        owned: OwnedBytes {
            decoded_assets: document_bytes.saturating_add(object_count.saturating_mul(256)),
            staging_buffers: document_bytes,
            textures_and_mips: object_count
                .saturating_mul(256 * 1024)
                .saturating_add(512 * 1024),
            geometry: object_count.saturating_mul(8 * 1024),
            glyph_atlases: 512 * 1024,
            tile_render_targets: per_scene_tile_budget / 2,
            upload_rings: 512 * 1024,
            pipeline_state: 256 * 1024,
            bind_group_data: object_count.saturating_mul(256),
            frame_pool: 0,
        },
    }
}

fn admission_protocol_error(error: crate::capabilities::AdmissionError) -> ProtocolError {
    ProtocolError::new(
        ErrorCode::EngineBusy,
        format!("resource admission refused: {error:?}"),
    )
}

/// An event plus who it is for.
///
/// `target_client` of `None` means every connected client. The filter happens at the
/// socket rather than by giving each client its own channel, so ordering across all
/// events stays consistent for every subscriber.
#[derive(Debug, Clone)]
pub struct EngineEvent {
    pub target_client: Option<String>,
    pub envelope: Envelope,
    /// Raw private Editor-view frame. WebSocket transport sends this as a binary
    /// frame, never as JSON/base64; IPC intentionally does not expose this view.
    pub binary: Option<Vec<u8>>,
}

pub struct Engine {
    pub config: EngineConfig,
    pub engine_id: String,
    pub capabilities: EngineCapabilities,
    /// `None` only in tests and on a control-plane-only engine.
    ///
    /// Every non-rendering path — connect, load, prepare-gating, playout state,
    /// status, diagnostics — works without a device, so the protocol is testable
    /// on a machine with no adapter. A render attempt without one is a clear error
    /// rather than a crash.
    gpu: Option<Arc<GpuContext>>,
    state: EngineStateMachine,
    stages: HashMap<String, StageDocument>,
    scenes: HashMap<String, LoadedScene>,
    program_scene_id: Option<String>,
    preview_scene_id: Option<String>,
    /// Preview owns a playhead independent from Program. Sharing `LoadedScene::frame`
    /// made Cue either freeze Preview or rewind a scene that was already on air.
    preview_start_frame: u64,
    preview_started_at: Option<Instant>,
    outputs: Vec<OutputInstance>,
    /// The asset store: content-addressed cache, uploads in flight, reference counts.
    assets: crate::assets::AssetStore,
    /// Sole owner of decoded/GPU/prepared-runtime admission. It is touched only
    /// during preparation and lifecycle transitions, never during a render tick.
    resource_governor: ResourceGovernor,
    /// Registered preview streams, keyed by stream id.
    ///
    /// Held by the engine rather than by a connection so a stream's identity survives a
    /// momentary socket problem; they are dropped when their client disconnects.
    preview_streams: std::collections::BTreeMap<String, crate::stream::PreviewStream>,
    /// Renderer restarts performed, reported in status.
    renderer_restarts: u64,
    /// Persistent preview renderer.
    ///
    /// Separate from the Program one: a preview repoint resizes its target, and doing
    /// that to the renderer holding Program would drop frames on air to serve a
    /// thumbnail.
    preview_renderer: Option<crate::scene_renderer::SceneRenderer>,
    /// Persistent Program renderer, built on the first frame that goes on air.
    /// Private native renderers are keyed by Editor connection/view identity and
    /// never reused by Preview or Program.
    editor_renderers: std::collections::BTreeMap<String, crate::scene_renderer::SceneRenderer>,
    ///
    /// Held here rather than created per frame because building it compiles both
    /// shader pipelines: doing that every frame cost 482ms a frame against a 20ms
    /// budget.
    program_renderer: Option<crate::scene_renderer::SceneRenderer>,
    /// Durable Program/output mutation journal. Failure to append a protected
    /// command rejects its acknowledgement rather than claiming recoverability.
    recovery_journal: Option<crate::recovery::RecoveryJournal>,
    recovery_gate: crate::recovery::RecoveryGate,
    audit: AuditLog,
    started_at: Instant,
    event_sequence: u64,
    events: broadcast::Sender<EngineEvent>,

    pub connected_clients: usize,
    pub messages_received: u64,
    pub messages_sent: u64,
    pub duplicates_dropped: u64,
    pub sequence_gaps: u64,
    pub resync_count: u64,
    frames_rendered: u64,
    /// Patches applied. Reported so the ratio against `resync_count` is visible:
    /// a client that is silently resyncing every edit is losing the whole point.
    patches_applied: u64,
    frames_dropped: u64,
    frames_late: u64,
    last_render_micros: u64,
    warnings: Vec<String>,
    errors: Vec<String>,
}

impl Engine {
    pub fn new(
        config: EngineConfig,
        engine_id: String,
        capabilities: EngineCapabilities,
        gpu: Arc<GpuContext>,
    ) -> Self {
        Self::with_optional_gpu(config, engine_id, capabilities, Some(gpu))
    }

    /// Build an engine with no GPU.
    ///
    /// For tests and for a control-plane-only deployment. Rendering is refused
    /// with a stated reason; everything else behaves identically.
    pub fn without_gpu(
        config: EngineConfig,
        engine_id: String,
        capabilities: EngineCapabilities,
    ) -> Self {
        Self::with_optional_gpu(config, engine_id, capabilities, None)
    }

    fn with_optional_gpu(
        config: EngineConfig,
        engine_id: String,
        capabilities: EngineCapabilities,
        gpu: Option<Arc<GpuContext>>,
    ) -> Self {
        let audit_path = config
            .security
            .audit_log_path
            .as_ref()
            .filter(|_| config.security.audit_log_enabled)
            .map(std::path::PathBuf::from);

        let (events, _) = broadcast::channel(256);
        // Built before the struct literal takes ownership of the config.
        let assets = crate::assets::AssetStore::new(&config.assets);
        let resource_governor =
            ResourceGovernor::new(crate::capabilities::ResourceBudget::from_config(&config));
        let recovery_journal = crate::recovery::RecoveryJournal::open(
            std::path::Path::new(&config.assets.cache_directory).join("recovery"),
        )
        .ok();
        let mut recovery_gate = crate::recovery::RecoveryGate::default();
        // A new/clean journal has no prior output to restore; it still traverses
        // the gate so output activation cannot accidentally bypass it.
        if recovery_journal.is_some() {
            let _ = recovery_gate.replayed_off_air();
            let _ = recovery_gate.validate_first_frame(true);
        }

        Self {
            config,
            engine_id,
            capabilities,
            gpu,
            state: EngineStateMachine::new(EngineState::Ready),
            stages: HashMap::new(),
            scenes: HashMap::new(),
            program_scene_id: None,
            preview_scene_id: None,
            preview_start_frame: 0,
            preview_started_at: None,
            outputs: Vec::new(),
            assets,
            resource_governor,
            preview_streams: std::collections::BTreeMap::new(),
            preview_renderer: None,
            editor_renderers: std::collections::BTreeMap::new(),
            renderer_restarts: 0,
            program_renderer: None,
            recovery_journal,
            recovery_gate,
            audit: AuditLog::new(audit_path, 512),
            started_at: Instant::now(),
            event_sequence: 0,
            events,
            connected_clients: 0,
            messages_received: 0,
            messages_sent: 0,
            duplicates_dropped: 0,
            sequence_gaps: 0,
            resync_count: 0,
            frames_rendered: 0,
            patches_applied: 0,
            frames_dropped: 0,
            frames_late: 0,
            last_render_micros: 0,
            warnings: Vec::new(),
            errors: Vec::new(),
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    pub fn state(&self) -> EngineState {
        self.state.state()
    }

    /// Broadcast an engine-initiated event to every connected client.
    fn emit(&mut self, event_type: &str, payload: Value) {
        self.emit_to(None, event_type, payload);
    }

    /// Send an event, optionally to one client only.
    ///
    /// Preview frames are addressed: a JPEG of an Editor's viewport has no business
    /// arriving at Playout, which never asked for it and would pay the bandwidth.
    fn emit_to(&mut self, target_client: Option<String>, event_type: &str, payload: Value) {
        self.event_sequence += 1;
        let envelope = Envelope::event(
            event_type,
            payload,
            &self.engine_id,
            self.event_sequence,
            now_ms(),
        );
        // A send failure only means nobody is listening, which is normal.
        let _ = self.events.send(EngineEvent {
            target_client,
            envelope,
            binary: None,
        });
    }

    fn emit_binary_to(&mut self, target_client: String, bytes: Vec<u8>) {
        self.event_sequence += 1;
        let _ = self.events.send(EngineEvent {
            target_client: Some(target_client),
            envelope: Envelope::event(
                "event.editorViewBinary",
                Value::Null,
                &self.engine_id,
                self.event_sequence,
                now_ms(),
            ),
            binary: Some(bytes),
        });
    }

    fn transition(&mut self, next: EngineState, reason: &str) {
        let change = self.state.transition(next, reason, now_ms());
        if change.rejected {
            return;
        }
        self.emit(
            "event.engineState",
            json!({
                "state": change.to.as_str(),
                "previousState": change.from.as_str(),
                "reason": change.reason,
            }),
        );
    }

    fn record_audit(
        &mut self,
        principal: &ConnectionPrincipal,
        request: RequestType,
        message_type: &str,
        scene_ref: Option<SceneRef>,
        outcome: &str,
        override_reason: Option<String>,
    ) {
        if !request.is_state_changing() {
            return;
        }
        self.audit.record(AuditEntry {
            at_ms: now_ms(),
            client_id: principal.connection_id().to_string(),
            message_type: message_type.to_string(),
            scene_ref,
            outcome: outcome.to_string(),
            override_reason,
        });
    }

    fn persist_recovery_command(
        &mut self,
        request: RequestType,
        envelope: &Envelope,
        scene_ref: Option<&SceneRef>,
    ) -> Result<(), ProtocolError> {
        use RequestType::*;
        if !matches!(
            request,
            Cue | TakeOnline | TakeOffline | Continue | Update | Stop | Clear | Replace
                | Transition | OutputConfigure | OutputStart | OutputStop | OutputRemove
        ) {
            return Ok(());
        }
        let package_checksum = scene_ref
            .map(SceneRef::cache_key)
            .unwrap_or_else(|| "engine-configuration".to_string());
        let state = self.status_payload(false);
        let output_lease = self.engine_id.clone();
        let output_fence = self.event_sequence;
        let journal = self.recovery_journal.as_mut().ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InternalError,
                "recovery journal is unavailable; protected command was not acknowledged",
            )
        })?;
        let command = journal
            .append_accepted(crate::recovery::RecoveryCommand {
                state_revision: 0,
                idempotency_key: envelope.message_id.clone(),
                precondition_revision: scene_ref.map(|reference| reference.revision),
                message_type: envelope.message_type.clone(),
                payload: envelope.payload.clone(),
                package_checksum: package_checksum.clone(),
                output_lease: output_lease.clone(),
                output_fence,
            })
            .map_err(|error| ProtocolError::new(ErrorCode::InternalError, error.to_string()))?;
        journal
            .write_snapshot(crate::recovery::RecoverySnapshot {
                watermark: command.state_revision,
                state,
                package_checksums: vec![package_checksum],
                output_lease,
                output_fence,
            })
            .map_err(|error| ProtocolError::new(ErrorCode::InternalError, error.to_string()))
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    /// Handle one request and produce a reply.
    ///
    /// Returns `(reply_type, payload)`. Errors become `reply.error`, so a caller
    /// never has to decide how to report a failure.
    pub fn handle(
        &mut self,
        request: RequestType,
        envelope: &Envelope,
        principal: &ConnectionPrincipal,
    ) -> Result<(String, Value), ProtocolError> {
        if !principal.allows(request) {
            let error = ProtocolError::new(
                ErrorCode::UnauthorizedRole,
                format!(
                    "{} role is not permitted to execute {}",
                    principal.role().as_str(),
                    envelope.message_type
                ),
            );
            self.record_audit(
                principal,
                request,
                &envelope.message_type,
                envelope.scene_ref.clone(),
                &format!("refused: {}", error.code.as_str()),
                None,
            );
            return Err(error);
        }

        let scene_ref = if request.requires_scene_ref() {
            let scene_ref = envelope.scene_ref.clone().ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("{} requires sceneRef", envelope.message_type),
                )
            })?;
            if matches!(request.group(), "playout" | "preview") {
                scene_ref.require_published_for_program()?;
            }
            Some(scene_ref)
        } else {
            envelope.scene_ref.clone()
        };

        // Runtime maps, render caches, streams, and asset references use this
        // collision-free canonical key. Source documents are rewritten only in
        // this private handler view, never at the wire boundary.
        let mut scoped_payload = envelope.payload.clone();
        if let (Some(scene_ref), Some(object)) =
            (scene_ref.as_ref(), scoped_payload.as_object_mut())
        {
            let runtime_key = scene_ref.cache_key();
            object.insert("sceneId".to_string(), Value::String(runtime_key.clone()));
            object.insert("sceneRevision".to_string(), Value::from(scene_ref.revision));
            if matches!(request, RequestType::SceneLoad | RequestType::SceneFullSync) {
                if let Some(scene) = object.get_mut("scene").and_then(Value::as_object_mut) {
                    scene.insert("id".to_string(), Value::String(runtime_key));
                    scene.insert("revision".to_string(), Value::from(scene_ref.revision));
                }
            }
            if request == RequestType::SceneApplyPatch {
                if let Some(patch) = object.get_mut("patch").and_then(Value::as_object_mut) {
                    patch.insert("sceneId".to_string(), Value::String(scene_ref.cache_key()));
                }
            }
        }
        let payload = &scoped_payload;
        let client_id = principal.connection_id();
        let mut result = match request {
            RequestType::Hello => self.handle_hello(payload, principal),
            RequestType::Authenticate => Ok((
                "reply.ack".to_string(),
                json!({ "requestType": envelope.message_type }),
            )),
            RequestType::Heartbeat => self.handle_heartbeat(payload),
            RequestType::Capabilities | RequestType::GetCapabilities => Ok((
                "reply.capabilities".to_string(),
                serde_json::to_value(&self.capabilities).unwrap_or(Value::Null),
            )),
            RequestType::Disconnect => Ok((
                "reply.ack".to_string(),
                json!({ "requestType": envelope.message_type }),
            )),

            RequestType::StageLoad => self.handle_stage_load(payload),
            RequestType::StageUnload => self.handle_stage_unload(payload),

            RequestType::SceneLoad => self.handle_scene_load(payload, false),
            RequestType::SceneFullSync => {
                // A full sync replaces the document wholesale.
                self.invalidate_program_render();
                self.handle_scene_load(payload, true)
            }
            RequestType::SceneUnload => {
                self.invalidate_program_render();
                self.handle_scene_unload(payload)
            }
            RequestType::SceneValidate => self.handle_scene_validate(payload),
            RequestType::ScenePrepare => self.handle_scene_prepare(payload),
            RequestType::SceneApplyPatch => self.handle_scene_patch(payload),

            RequestType::Cue => self.handle_cue(payload),
            RequestType::TakeOnline => self.handle_take_online(
                payload,
                client_id,
                scene_ref.as_ref().expect("takeOnline requires SceneRef"),
            ),
            RequestType::TakeOffline => self.handle_take_offline(payload),
            RequestType::Continue => self.handle_continue(payload),
            RequestType::Update => self.handle_update(payload),
            RequestType::Stop => self.handle_stop(payload),
            RequestType::Clear => self.handle_clear(payload),
            RequestType::Replace => self.handle_replace(payload),
            RequestType::Transition => self.handle_transition(payload),

            RequestType::PreviewRequest => self.handle_preview(payload),
            RequestType::EditorViewRequest => self.handle_editor_view(
                payload,
                scene_ref.as_ref().expect("editor view requires SceneRef"),
                client_id,
            ),

            RequestType::GetStatus => Ok(("reply.status".to_string(), self.status_payload(false))),
            RequestType::GetDiagnostics => {
                let include_tiles = payload
                    .get("includeTiles")
                    .and_then(Value::as_bool)
                    .unwrap_or(self.config.diagnostics.include_tile_detail);
                Ok((
                    "reply.diagnostics".to_string(),
                    self.status_payload(include_tiles),
                ))
            }
            RequestType::SetConfiguration => self.handle_set_configuration(payload),

            RequestType::OutputList => Ok(("reply.outputs".to_string(), self.outputs_payload())),
            RequestType::OutputConfigure => self.handle_output_configure(payload),
            RequestType::OutputStart => {
                self.recovery_gate.permit_output().map_err(|error| {
                    ProtocolError::new(ErrorCode::OutputError, error.to_string())
                })?;
                self.handle_output_start(payload)
            }
            RequestType::OutputStop => self.handle_output_stop(payload),
            RequestType::OutputRemove => self.handle_output_remove(payload),

            RequestType::AssetRegister => self.handle_asset_register(payload),
            RequestType::AssetUpload => self.handle_asset_upload(payload),
            RequestType::AssetValidate => self.handle_asset_validate(payload),
            RequestType::AssetPreload => self.handle_asset_preload(payload),
            RequestType::AssetRelease => self.handle_asset_release(payload),
            RequestType::PreviewStreamStart => self.handle_stream_start(payload, client_id),
            RequestType::PreviewStreamStop => self.handle_stream_stop(payload, client_id),
            RequestType::PreviewSetViewport => self.handle_stream_set_viewport(payload, client_id),
            RequestType::RestartRenderer => self.handle_restart_renderer(payload, client_id),
        };
        if result.is_ok() {
            if let Err(error) = self.persist_recovery_command(request, envelope, scene_ref.as_ref()) {
                self.recovery_gate.degrade();
                self.emit(
                    "event.recoveryDegraded",
                    json!({ "reason": error.message, "command": envelope.message_type }),
                );
                result = Err(error);
            }
        }

        match &result {
            Ok(_) => self.record_audit(
                principal,
                request,
                &envelope.message_type,
                scene_ref.clone(),
                "accepted",
                None,
            ),
            Err(error) => self.record_audit(
                principal,
                request,
                &envelope.message_type,
                scene_ref,
                &format!("refused: {}", error.code.as_str()),
                None,
            ),
        }

        result
    }

    // -----------------------------------------------------------------------
    // Connection
    // -----------------------------------------------------------------------

    fn handle_hello(
        &mut self,
        payload: &Value,
        principal: &ConnectionPrincipal,
    ) -> Result<(String, Value), ProtocolError> {
        let client_name = payload
            .get("clientName")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let client_role = payload
            .get("clientRole")
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        let supported = payload
            .get("supportedProtocolVersions")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_u64)
                    .collect::<Vec<u64>>()
            })
            .unwrap_or_default();

        if !supported.is_empty()
            && !supported.contains(&u64::from(crate::protocol::PROTOCOL_VERSION))
        {
            return Err(ProtocolError::new(
                ErrorCode::ProtocolVersionMismatch,
                format!(
                    "client supports protocol {supported:?} but this engine speaks {}",
                    crate::protocol::PROTOCOL_VERSION
                ),
            ));
        }

        tracing::info!(
            %client_name,
            declared_role = %client_role,
            connection_role = principal.role().as_str(),
            "client said hello"
        );

        Ok((
            "reply.hello".to_string(),
            json!({
                "engineId": self.engine_id,
                "engineName": self.config.identity.name,
                "softwareVersion": self.capabilities.software_version,
                "protocolVersion": crate::protocol::PROTOCOL_VERSION,
                "state": self.state.state().as_str(),
                "authenticationRequired": self.config.auth.required,
                "connectionRole": principal.role().as_str(),
            }),
        ))
    }

    fn handle_heartbeat(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        // Echo the client's clock back so it can measure the round trip.
        let sent_at_ms = payload.get("sentAtMs").and_then(Value::as_u64).unwrap_or(0);
        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "connection.heartbeat",
                "sentAtMs": sent_at_ms,

                "engineTimeMs": now_ms(),
            }),
        ))
    }
    /// Render an Editor-only authoring view and queue its bytes to that one
    /// connection. This path cannot observe or mutate Preview/Program selection.
    fn handle_editor_view(
        &mut self,
        payload: &Value,
        scene_ref: &SceneRef,
        client_id: &str,
    ) -> Result<(String, Value), ProtocolError> {
        if scene_ref.domain != crate::protocol::SceneDomain::Authoring {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                "editor.view.request requires an authoring SceneRef",
            ));
        }
        let request: crate::editor_view::EditorViewRequest =
            serde_json::from_value(payload.clone()).map_err(|error| {
                ProtocolError::new(ErrorCode::InvalidPayload, format!("invalid editor view: {error}"))
            })?;
        let document = self
            .require_scene(&scene_ref.cache_key())?
            .source_document()
            .clone();
        let gpu = self.gpu.as_ref().cloned().ok_or_else(|| {
            ProtocolError::new(ErrorCode::DeviceLost, "editor view requires an active GPU")
        })?;
        let renderer_key = format!("{client_id}:{}", request.view_id);
        let renderer = self.editor_renderers.entry(renderer_key).or_insert_with(|| {
            crate::scene_renderer::SceneRenderer::new(&gpu, request.pixel_width, request.pixel_height)
        });
        let frame = crate::editor_view::render_editor_view(
            &gpu,
            renderer,
            scene_ref,
            &document,
            &request,
            self.config.preview.max_pixels,
        )?;
        let metadata = serde_json::to_value(&frame.metadata).map_err(|error| {
            ProtocolError::new(ErrorCode::InternalError, format!("editor view metadata failed: {error}"))
        })?;
        let bytes = crate::editor_view::pack_binary_frame(&frame.metadata, &frame.pixels)?;
        self.emit_binary_to(client_id.to_string(), bytes);
        Ok(("reply.editorView".to_string(), metadata))
    }

    // -----------------------------------------------------------------------
    // Stage
    // -----------------------------------------------------------------------

    fn handle_stage_load(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let stage_value = payload.get("stage").ok_or_else(|| {
            ProtocolError::new(ErrorCode::InvalidPayload, "stage.load needs a stage")
        })?;

        let stage: StageDocument =
            serde_json::from_value(stage_value.clone()).map_err(|error| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("stage document could not be parsed: {error}"),
                )
            })?;
        let stage = stage.normalized();

        let validation = stage.validate(&self.capabilities.stage_limits());
        if !validation.valid {
            let messages: Vec<String> = validation
                .issues
                .iter()
                .filter(|issue| issue.severity == crate::stage::IssueSeverity::Error)
                .map(|issue| format!("{}: {}", issue.code, issue.message))
                .collect();
            return Err(ProtocolError::new(
                ErrorCode::StageUnsupported,
                messages.join("; "),
            ));
        }

        let warnings: Vec<String> = validation
            .issues
            .iter()
            .map(|issue| format!("{}: {}", issue.code, issue.message))
            .collect();

        tracing::info!(
            stage_id = %stage.stage_id,
            logical_width = stage.canvas.logical_width,
            logical_height = stage.canvas.logical_height,
            tiling = stage.tiling.enabled,
            full_resolution_bytes = stage.canvas.full_resolution_bytes(),
            "stage loaded"
        );

        let stage_id = stage.stage_id.clone();
        self.stages.insert(stage_id.clone(), stage);

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "stage.load", "warnings": warnings, "stageId": stage_id }),
        ))
    }

    fn handle_stage_unload(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let stage_id = require_str(payload, "stageId")?;

        // A stage in use by a loaded scene cannot be dropped without breaking it.
        if let Some(scene) = self
            .scenes
            .values()
            .find(|scene| scene.stage_id.as_deref() == Some(stage_id))
        {
            return Err(ProtocolError::new(
                ErrorCode::StageUnsupported,
                format!(
                    "stage {stage_id} is in use by scene {}; unload the scene first",
                    scene.scene_id
                ),
            ));
        }

        self.stages.remove(stage_id);
        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "stage.unload" }),
        ))
    }

    // -----------------------------------------------------------------------
    // Scene
    // -----------------------------------------------------------------------

    fn handle_scene_load(
        &mut self,
        payload: &Value,
        full_sync: bool,
    ) -> Result<(String, Value), ProtocolError> {
        let scene_value = payload
            .get("scene")
            .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, "needs a scene"))?;

        let scene_id = scene_value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, "scene needs an id"))?
            .to_string();

        if !full_sync
            && self.scenes.len() >= self.config.stage.max_active_scenes as usize
            && !self.scenes.contains_key(&scene_id)
        {
            return Err(ProtocolError::new(
                ErrorCode::EngineBusy,
                format!(
                    "engine holds its maximum of {} active scenes; unload one first",
                    self.config.stage.max_active_scenes
                ),
            ));
        }

        let name = scene_value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&scene_id)
            .to_string();
        let revision = scene_value
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        let stage_id = payload
            .get("stageId")
            .and_then(Value::as_str)
            .map(str::to_string);

        // Resolve the stage: an explicit one, or the implicit canvas-sized stage
        // every pre-stage scene behaves as.
        let stage = match &stage_id {
            Some(id) => self.stages.get(id).cloned().ok_or_else(|| {
                ProtocolError::new(ErrorCode::StageNotFound, format!("no stage {id}"))
            })?,
            None => {
                let width = scene_value
                    .get("canvas")
                    .and_then(|canvas| canvas.get("width"))
                    .and_then(Value::as_f64)
                    .unwrap_or(1920.0);
                let height = scene_value
                    .get("canvas")
                    .and_then(|canvas| canvas.get("height"))
                    .and_then(Value::as_f64)
                    .unwrap_or(1080.0);
                StageDocument::implicit(format!("stage_implicit_{scene_id}"), width, height)
            }
        };

        let tiling = self.tiling_for(&stage);
        let grid = TileGrid::new(&stage.canvas, &tiling);
        let mut tiles = TileManager::new(grid, &tiling, 1.0);

        // Index every object so tile selection and dirty tracking work.
        let objects = scene_object_bounds(scene_value);
        let object_count = objects.len();
        for (object_id, bounds, filters) in &objects {
            tiles.sync_object(object_id, *bounds, filters);
        }

        let builder = TileSceneBuilder::new(scene_value.clone(), revision.to_string());

        let previous_frame = self
            .scenes
            .get(&scene_id)
            .map(|scene| scene.frame)
            .unwrap_or(0);

        let loaded = LoadedScene {
            scene_id: scene_id.clone(),
            name,
            revision,
            stage_id: stage_id.clone().or_else(|| Some(stage.stage_id.clone())),
            preparation: PreparationState::Loading,
            warnings: Vec::new(),
            take_blockers: vec!["scene has not been prepared".to_string()],
            object_count,
            tiles,
            builder,
            frame: previous_frame,
            prepared_tile_count: 0,
            last_used_ms: now_ms(),
        };

        self.stages
            .entry(stage.stage_id.clone())
            .or_insert_with(|| stage.clone());
        self.scenes.insert(scene_id.clone(), loaded);

        if full_sync {
            self.resync_count += 1;
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("requested");
            tracing::info!(%scene_id, %reason, "full scene sync applied");
        }

        tracing::info!(%scene_id, revision, object_count, "scene loaded");

        self.emit(
            "event.sceneLifecycle",
            json!({
                "sceneId": scene_id,
                "revision": revision,
                "state": PreparationState::Loading.as_str(),
                "channel": Value::Null,
                "warnings": [],
            }),
        );

        // `prepare: true` prepares immediately; otherwise Playout decides when.
        let prepare_now = payload
            .get("prepare")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if prepare_now {
            let prepared = self.prepare_scene(&scene_id)?;
            return Ok(("reply.scenePrepared".to_string(), prepared));
        }

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": if full_sync { "scene.fullSync" } else { "scene.load" } }),
        ))
    }

    fn handle_scene_prepare(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        let prepared = self.prepare_scene(&scene_id)?;
        Ok(("reply.scenePrepared".to_string(), prepared))
    }

    fn resource_priority(&self, scene_id: &str) -> ResourcePriority {
        if self.program_scene_id.as_deref() == Some(scene_id) {
            ResourcePriority::Program
        } else if self.preview_scene_id.as_deref() == Some(scene_id) {
            ResourcePriority::PlayoutPreview
        } else {
            ResourcePriority::Warm
        }
    }

    /// Prepare a scene's tiles.
    ///
    /// Preparation is what turns a loaded document into something renderable, and
    /// it is the gate `TakeOnline` checks. It builds the tile-local scenes for the
    /// tiles any active viewport needs, so a Take does not pay that cost.
    fn prepare_scene(&mut self, scene_id: &str) -> Result<Value, ProtocolError> {
        let started = Instant::now();
        self.transition(EngineState::Preparing, "preparing a scene");
        let stage = self.stage_for_scene(scene_id)?;
        let viewport_rects = self.viewport_rects(&stage);

        // Estimate and reserve before the first decode/shape/tessellation/upload.
        // This is the preparation-plane transaction boundary; render ticks never
        // scan the governor or evict resources.
        let estimate = {
            let scene = self.scenes.get(scene_id).ok_or_else(|| {
                ProtocolError::new(ErrorCode::SceneNotFound, format!("no scene {scene_id}"))
            })?;
            estimate_prepared_runtime(
                scene,
                self.resource_priority(scene_id),
                self.resource_governor.budget(),
            )
        };
        let reservation_outcome = match self.resource_governor.reserve(scene_id, estimate) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.transition(EngineState::Ready, "resource admission refused");
                return Err(admission_protocol_error(error));
            }
        };
        for evicted_scene_id in &reservation_outcome.evicted {
            if let Some(evicted_scene) = self.scenes.get_mut(evicted_scene_id) {
                evicted_scene.builder.clear();
                evicted_scene.tiles.mark_all_dirty();
                evicted_scene.prepared_tile_count = 0;
                evicted_scene.preparation = PreparationState::Loading;
                evicted_scene.take_blockers =
                    vec!["prepared runtime was evicted by resource admission".to_string()];
            }
        }
        let reservation = reservation_outcome.reservation;

        // Asset readiness is part of being prepared. A scene whose logo has not arrived is
        // not ready to go on air, and the operator should learn that here rather than from
        // a hole in the picture.
        let declared_assets = self
            .scenes
            .get(scene_id)
            .map(|scene| crate::assets::AssetStore::declared_asset_ids(scene.source_document()))
            .unwrap_or_default();
        let missing_assets = self.assets.reference(scene_id, &declared_assets, now_ms());

        let scene = self.scenes.get_mut(scene_id).ok_or_else(|| {
            ProtocolError::new(ErrorCode::SceneNotFound, format!("no scene {scene_id}"))
        })?;

        let selection = scene.tiles.select_tiles(&TileSelectionRequest {
            frame: scene.frame,
            viewports: viewport_rects,
            include_clean: true,
            ..Default::default()
        });

        let mut warnings = Vec::new();
        let mut failures: Vec<String> = missing_assets
            .iter()
            .map(|asset_id| format!("asset {asset_id} is not available on this engine"))
            .collect();
        let mut prepared = 0usize;

        // Bound the work: preparing every tile of a 9,604-tile grid up front would
        // stall the connection. Viewport-driven selection already narrows it, and
        // anything else prepares lazily on first render.
        for tile_id in selection.to_render.iter().take(256) {
            let descriptor = match scene.tiles.get(tile_id) {
                Some(descriptor) => descriptor.clone(),
                None => continue,
            };
            match scene.builder.prepared_for_tile(&descriptor, 1.0) {
                Ok(tile_scene) => {
                    prepared += 1;
                    for warning in &tile_scene.prepared.warnings {
                        if !warnings.contains(warning) {
                            warnings.push(warning.clone());
                        }
                    }
                    for blocker in &tile_scene.prepared.take_blockers {
                        if !failures.contains(blocker) {
                            failures.push(blocker.clone());
                        }
                    }
                }
                Err(error) => {
                    let message = format!("tile {tile_id}: {error}");
                    if !failures.contains(&message) {
                        failures.push(message);
                    }
                }
            }
        }

        scene.prepared_tile_count = prepared;
        scene.warnings = warnings.clone();
        scene.take_blockers = failures.clone();
        scene.last_used_ms = now_ms();
        scene.preparation = if !failures.is_empty() {
            PreparationState::Failed
        } else if warnings.is_empty() {
            PreparationState::Ready
        } else {
            PreparationState::ReadyWithWarnings
        };

        let preparation_succeeded = failures.is_empty();
        if !preparation_succeeded {
            // A failed prepare may have populated tile-local prepared state. It
            // cannot remain resident after the transaction rolls back.
            scene.builder.clear();
            scene.prepared_tile_count = 0;
            prepared = 0;
        }

        let state = scene.preparation;
        let revision = scene.revision;
        let preparation_ms = started.elapsed().as_millis() as u64;
        let actual_owned = estimate.owned;

        tracing::info!(
            %scene_id,
            state = state.as_str(),
            prepared_tiles = prepared,
            warnings = warnings.len(),
            blockers = failures.len(),
            preparation_ms,
            "scene prepared"
        );
        // The mutable scene borrow ends after the last read above, before this
        // frame-boundary transaction commits or rolls back the reservation.
        let last_used_ms = scene.last_used_ms;
        if preparation_succeeded {
            self.resource_governor
                .uploaded(reservation)
                .map_err(admission_protocol_error)?;
            self.resource_governor
                .commit(reservation, actual_owned, true, last_used_ms)
                .map_err(admission_protocol_error)?;
        } else {
            self.resource_governor.rollback(reservation);
        }

        self.transition(EngineState::Ready, "preparation finished");
        self.emit(
            "event.sceneLifecycle",
            json!({
                "sceneId": scene_id,
                "revision": revision,
                "state": state.as_str(),
                "channel": Value::Null,
                "warnings": warnings,
            }),
        );

        Ok(json!({
            "sceneId": scene_id,
            "revision": revision,
            "state": state.as_str(),
            "warnings": warnings,
            "takeBlockers": failures,
            "preparedTileCount": prepared,
            // What the scene declared and how much of it is actually here.
            "declaredAssetCount": declared_assets.len(),
            "preparedAssetCount": declared_assets.len().saturating_sub(missing_assets.len()),
            "missingAssetIds": missing_assets,
            "preparationMs": preparation_ms,
        }))
    }

    fn handle_scene_validate(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_value = payload
            .get("scene")
            .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, "needs a scene"))?;
        let scene_id = scene_value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        // Validation is a dry run: prepare the document without retaining it.
        let mut errors = Vec::new();
        let mut warnings = Vec::new();
        let mut unsupported = Vec::new();

        match grapix_render_core::scene::prepare_scene(scene_value) {
            Ok(prepared) => {
                warnings.extend(prepared.warnings.clone());
                unsupported.extend(prepared.take_blockers.clone());
            }
            Err(error) => errors.push(error.to_string()),
        }

        Ok((
            "reply.sceneValidation".to_string(),
            json!({
                "sceneId": scene_id,
                "valid": errors.is_empty(),
                "errors": errors,
                "warnings": warnings,
                "unsupportedFeatures": unsupported,
                "missingAssetIds": [],
            }),
        ))
    }

    /// Apply an incremental patch to a retained scene.
    ///
    /// The alternative — refusing and making the client resend the whole document —
    /// costs a full re-prepare for a nudged rectangle. What makes this safe rather than
    /// merely faster is that it is revision-gated and atomic: a patch based on a
    /// revision the engine does not hold is refused with the resync instruction, and a
    /// patch that fails part way through leaves the document untouched. An engine
    /// rendering a document nobody else holds is invisible from the output, which is
    /// why neither is negotiable.
    fn handle_scene_patch(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let patch_value = payload
            .get("patch")
            .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, "needs a patch"))?;

        let patch: crate::patch::ScenePatch =
            serde_json::from_value(patch_value.clone()).map_err(|error| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    // Naming the operation set is what lets a client tell "I sent a typo"
                    // from "this engine is older than my Editor".
                    format!(
                        "patch could not be read: {error}. Supported operations are \
                         object.created, object.deleted, object.transform, object.text, \
                         object.material, object.animation, object.visibility, \
                         object.property, layer.reorder, asset.changed, material.changed, \
                         timeline.changed, dataContext.changed, surface.changed, \
                         outputMapping.changed, scene.published, scene.recalled"
                    ),
                )
            })?;

        let scene_id = patch.scene_id.clone();
        if !self.scenes.contains_key(&scene_id) {
            return Err(ProtocolError::new(
                ErrorCode::SceneNotFound,
                format!("no scene {scene_id}"),
            ));
        }

        // Bounds before the patch, so a moved object can dirty the tiles it left as
        // well as the ones it entered.
        let bounds_before: std::collections::HashMap<
            String,
            (crate::stage::Rect, Vec<crate::tile::FilterOverscan>),
        > = scene_object_bounds(self.scenes[&scene_id].source_document())
            .into_iter()
            .map(|(id, rect, filters)| (id, (rect, filters)))
            .collect();

        let mut document = self.scenes[&scene_id].source_document().clone();
        let outcome = match crate::patch::apply_patch(&mut document, &patch) {
            Ok(outcome) => outcome,
            Err(error) => {
                let code = match error.failure {
                    crate::patch::PatchFailure::RevisionMismatch
                    | crate::patch::PatchFailure::RevisionNotAdvancing => {
                        self.resync_count += 1;
                        ErrorCode::RevisionMismatch
                    }
                    crate::patch::PatchFailure::MalformedDocument => {
                        self.resync_count += 1;
                        ErrorCode::ResyncRequired
                    }
                    _ => ErrorCode::InvalidPayload,
                };
                let where_at = error
                    .operation_index
                    .map(|index| format!(" (operation {index})"))
                    .unwrap_or_default();
                return Err(ProtocolError::new(
                    code,
                    format!("{}{where_at}: {}", error.failure.code(), error.message),
                ));
            }
        };

        // Bounds after, for the objects the patch touched.
        let bounds_after: std::collections::HashMap<
            String,
            (crate::stage::Rect, Vec<crate::tile::FilterOverscan>),
        > = scene_object_bounds(&document)
            .into_iter()
            .map(|(id, rect, filters)| (id, (rect, filters)))
            .collect();

        let revision = outcome.revision;
        let object_count = document
            .get("objects")
            .and_then(Value::as_array)
            .map(|objects| objects.len())
            .unwrap_or(0);

        let mut dirtied_tiles = 0usize;
        if let Some(scene) = self.scenes.get_mut(&scene_id) {
            scene.builder.update_scene(document, revision.to_string());
            scene.revision = revision;
            scene.object_count = object_count;
            scene.last_used_ms = now_ms();

            if outcome.whole_scene_dirty {
                // Draw order, timeline, a data value any binding might read: none of
                // these can be attributed to a set of objects.
                scene.tiles.mark_all_dirty();
                dirtied_tiles = scene.tiles.tracked_tile_count();
            } else {
                for object_id in &outcome.removed_objects {
                    dirtied_tiles += scene.tiles.remove_object(object_id).left.len();
                }
                for object_id in &outcome.touched_objects {
                    match bounds_after.get(object_id) {
                        Some((rect, filters)) => {
                            let delta = scene.tiles.sync_object(object_id, *rect, filters);
                            dirtied_tiles += delta.left.len() + delta.entered.len();
                            // An object that changed content without moving still has to
                            // redraw where it already is.
                            if delta.left.is_empty() && delta.entered.is_empty() {
                                dirtied_tiles += scene.tiles.invalidate_object(object_id).len();
                            }
                        }
                        // Present before and gone from the bounds list after: treat it as
                        // removed rather than silently leaving stale pixels.
                        None if bounds_before.contains_key(object_id) => {
                            dirtied_tiles += scene.tiles.remove_object(object_id).left.len();
                        }
                        None => {}
                    }
                }
            }
        }

        // The Program renderer caches the prepared scene by revision, so a new revision
        // invalidates it on its own. Doing it explicitly costs nothing and does not rely
        // on that remaining true.
        self.invalidate_program_render();
        self.patches_applied += 1;

        tracing::debug!(
            %scene_id,
            revision,
            operations = outcome.applied_operations,
            touched = outcome.touched_objects.len(),
            removed = outcome.removed_objects.len(),
            whole_scene = outcome.whole_scene_dirty,
            dirtied_tiles,
            "scene patch applied"
        );

        let mut warnings = Vec::new();
        if outcome.stage_changed {
            // The engine holds stages separately, so a surface change in a scene patch
            // cannot be applied here. Saying so is better than accepting it silently.
            warnings.push(
                "surface and output-mapping operations were accepted but do not change a \
                 stage; send stage.load to change the stage"
                    .to_string(),
            );
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "scene.applyPatch",
                "sceneId": scene_id,
                "sceneRevision": revision,
                "operationsApplied": outcome.applied_operations,
                "objectsTouched": outcome.touched_objects,
                "objectsRemoved": outcome.removed_objects,
                "wholeSceneInvalidated": outcome.whole_scene_dirty,
                "tilesInvalidated": dirtied_tiles,
                "warnings": warnings,
            }),
        ))
    }

    /// Drop the Program renderer's cached scene.
    ///
    /// Cheap: the pipelines and the render target survive, only the prepared document
    /// is rebuilt on the next frame.
    fn invalidate_program_render(&mut self) {
        if let Some(renderer) = self.program_renderer.as_mut() {
            renderer.invalidate_scene();
        }
        // The preview renderer caches the same prepared document, so a data update that
        // did not bump the revision would leave a preview showing the old values while
        // Program shows the new ones.
        if let Some(renderer) = self.preview_renderer.as_mut() {
            renderer.invalidate_scene();
        }
    }

    fn handle_scene_unload(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();

        let force = payload
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // Unloading what is on Program puts black on air.
        if self.program_scene_id.as_deref() == Some(scene_id.as_str()) && !force {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!("scene {scene_id} is on Program; set force to unload it anyway"),
            ));
        }

        if self.scenes.remove(&scene_id).is_none() {
            return Err(ProtocolError::new(
                ErrorCode::SceneNotFound,
                format!("no scene {scene_id}"),
            ));
        }
        self.resource_governor.release(&scene_id);

        if self.program_scene_id.as_deref() == Some(scene_id.as_str()) {
            self.program_scene_id = None;
            self.transition(EngineState::Ready, "program scene force-unloaded");
        }
        if self.preview_scene_id.as_deref() == Some(scene_id.as_str()) {
            self.preview_scene_id = None;
        }

        // The scene stops holding asset references the moment it is gone. A stale
        // reference would make an asset permanently unreleasable.
        self.assets.dereference_scene(&scene_id);

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "scene.unload" }),
        ))
    }

    // -----------------------------------------------------------------------
    // Playout
    // -----------------------------------------------------------------------

    fn handle_cue(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        let channel = require_channel(payload)?;
        let start_frame = payload.get("startFrame").and_then(Value::as_u64);

        self.require_scene(&scene_id)?;
        self.check_revision(payload, &scene_id)?;

        match channel {
            Channel::Program => {
                // Cue never puts anything on air; that is what Take is for.
                return Err(ProtocolError::new(
                    ErrorCode::Unauthorized,
                    "Cue targets Preview or an auxiliary channel; use playout.takeOnline for Program",
                ));
            }
            Channel::Preview | Channel::Auxiliary => {
                // Preview owns an independent playhead. Cue always starts the previewed copy
                // from the requested frame, even when the same scene is already on Program.
                self.preview_start_frame = start_frame.unwrap_or(0);
                self.preview_started_at = Some(Instant::now());
                let previous_preview = self.preview_scene_id.replace(scene_id.clone());
                let now = now_ms();
                if let Some(previous_preview) = previous_preview {
                    if previous_preview != scene_id {
                        self.resource_governor.touch(
                            &previous_preview,
                            ResourcePriority::Warm,
                            false,
                            now,
                        );
                    }
                }
                self.resource_governor.touch(
                    &scene_id,
                    ResourcePriority::PlayoutPreview,
                    true,
                    now,
                );
                if let Some(scene) = self.scenes.get_mut(&scene_id) {
                    scene.last_used_ms = now;
                }
            }
        }

        self.emit(
            "event.channelChanged",
            json!({
                "channel": channel.as_str(),
                "sceneId": scene_id,
                "sceneRevision": self.scenes.get(&scene_id).map(|s| s.revision),
                "onAir": false,
            }),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.cue" }),
        ))
    }

    fn handle_take_online(
        &mut self,
        payload: &Value,
        client_id: &str,
        scene_ref: &SceneRef,
    ) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        let override_unprepared = payload
            .get("overrideUnprepared")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if let Some(transition) = payload.get("transitionId").and_then(Value::as_str) {
            // Only the cut is implemented. Refuse rather than substitute one.
            if !self
                .capabilities
                .supported_transitions
                .iter()
                .any(|supported| supported == transition)
                && transition != "cut"
            {
                return Err(ProtocolError::new(
                    ErrorCode::CapabilityUnsupported,
                    format!(
                        "transition \"{transition}\" is not implemented; this engine supports {:?} and will not substitute a cut",
                        self.capabilities.supported_transitions
                    ),
                ));
            }
        }

        self.require_scene(&scene_id)?;
        self.check_revision(payload, &scene_id)?;

        let (preparation, blockers) = {
            let scene = self.require_scene(&scene_id)?;
            (scene.preparation, scene.take_blockers.clone())
        };

        let unprepared = !matches!(
            preparation,
            PreparationState::Ready | PreparationState::ReadyWithWarnings
        ) || !blockers.is_empty();

        if unprepared && !override_unprepared {
            return Err(ProtocolError::new(
                ErrorCode::SceneNotPrepared,
                format!(
                    "scene {scene_id} is {} with {} blocker(s): {}. Set overrideUnprepared to take it anyway.",
                    preparation.as_str(),
                    blockers.len(),
                    blockers.join("; ")
                ),
            ));
        }

        let override_reason = if unprepared {
            Some(format!(
                "operator overrode {} take blocker(s) on {scene_id}: {}",
                blockers.len(),
                blockers.join("; ")
            ))
        } else {
            None
        };

        // An override is a legitimate operator decision, but an attributable one.
        if let Some(reason) = &override_reason {
            self.audit.record(AuditEntry {
                at_ms: now_ms(),
                client_id: client_id.to_string(),
                message_type: "playout.takeOnline".to_string(),
                scene_ref: Some(scene_ref.clone()),
                outcome: "accepted".to_string(),
                override_reason: Some(reason.clone()),
            });
        }

        let previous_program = self.program_scene_id.replace(scene_id.clone());
        let now = now_ms();
        if let Some(previous_program) = previous_program {
            if previous_program != scene_id {
                self.resource_governor
                    .touch(&previous_program, ResourcePriority::Warm, false, now);
            }
        }
        self.resource_governor
            .touch(&scene_id, ResourcePriority::Program, true, now);
        if let Some(scene) = self.scenes.get_mut(&scene_id) {
            // Back to the top. A take is what starts an "in" animation, so a scene taken a
            // second time must play from frame 0 rather than resuming wherever its last run
            // left the playhead — an operator re-taking a lower third has to see it animate
            // in again, not appear already finished.
            scene.frame = 0;
            scene.last_used_ms = now;
        }
        self.transition(EngineState::OnAir, "scene taken to program");

        // Taking a scene online is what starts the outputs. Until now the engine held
        // Program state without anything transmitting, which meant an operator could
        // see "on air" while no output existed. The reply says exactly what happened
        // to each output, and specifically which of them reach an audience.
        let mut warnings = override_reason.map(|r| vec![r]).unwrap_or_default();
        warnings.extend(self.start_program_outputs());

        self.emit(
            "event.channelChanged",
            json!({
                "channel": "program",
                "sceneId": scene_id,
                "sceneRevision": self.scenes.get(&scene_id).map(|s| s.revision),
                "onAir": true,
            }),
        );

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "playout.takeOnline",
                "warnings": warnings,
                "outputs": self.outputs.iter().map(|o| o.status()).collect::<Vec<_>>(),
                "liveOutputs": self.live_output_count(),
            }),
        ))
    }

    fn handle_take_offline(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();

        if self.program_scene_id.as_deref() != Some(scene_id.as_str()) {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("scene {scene_id} is not on Program"),
            ));
        }

        self.program_scene_id = None;
        // Nothing is on air, so nothing should be transmitting. Leaving an output
        // running would keep pushing the last rendered frame to air.
        let stopped = self.stop_program_outputs();
        self.transition(EngineState::Ready, "scene taken offline");
        self.emit(
            "event.channelChanged",
            json!({ "channel": "program", "sceneId": Value::Null, "sceneRevision": Value::Null, "onAir": false }),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.takeOffline", "outputsStopped": stopped }),
        ))
    }

    fn handle_continue(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        self.require_scene(&scene_id)?;

        // Frame-based: a continue advances the playhead, never a wall-clock timer.
        if let Some(scene) = self.scenes.get_mut(&scene_id) {
            scene.frame += 1;
            scene.last_used_ms = now_ms();
        }

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.continue" }),
        ))
    }

    fn handle_update(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        self.require_scene(&scene_id)?;
        self.check_revision(payload, &scene_id)?;

        let data = payload
            .get("data")
            .and_then(Value::as_object)
            .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, "update needs data"))?;

        // A data update changes bound values, so every tile holding a bound object
        // must redraw. Marking the whole scene dirty is conservative and correct;
        // per-binding tile invalidation is a phase H refinement.
        let keys: Vec<String> = data.keys().cloned().collect();
        if let Some(scene) = self.scenes.get_mut(&scene_id) {
            scene.tiles.mark_all_dirty();
            scene.builder.clear();
            scene.last_used_ms = now_ms();
        }

        // A data update does not bump the revision, so the Program renderer's cached
        // prepared scene would otherwise keep rendering the previous values. Rendering
        // a document nobody else holds is invisible from the output, which makes it
        // the worst kind of stale cache.
        self.invalidate_program_render();

        tracing::debug!(%scene_id, fields = keys.len(), "data update applied");

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.update", "warnings": [
                "data updates invalidate every tile in this engine build; per-binding invalidation is not yet implemented"
            ] }),
        ))
    }

    fn handle_stop(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let scene_id = require_str(payload, "sceneId")?.to_string();
        self.require_scene(&scene_id)?;

        if let Some(scene) = self.scenes.get_mut(&scene_id) {
            scene.frame = 0;
        }

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.stop" }),
        ))
    }

    fn handle_clear(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let channel = require_channel(payload)?;

        match channel {
            Channel::Program => {
                self.program_scene_id = None;
                // A clear is an operator saying "get it off air", so the outputs stop.
                self.stop_program_outputs();
                self.transition(EngineState::Ready, "program cleared");
            }
            Channel::Preview | Channel::Auxiliary => {
                self.preview_scene_id = None;
                self.preview_start_frame = 0;
                self.preview_started_at = None;
            }
        }

        self.emit(
            "event.channelChanged",
            json!({
                "channel": channel.as_str(),
                "sceneId": Value::Null,
                "sceneRevision": Value::Null,
                "onAir": false,
            }),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.clear" }),
        ))
    }

    fn handle_replace(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let incoming = require_str(payload, "incomingSceneId")?.to_string();
        let channel = require_channel(payload)?;
        let (preparation, blockers, revision) = {
            let scene = self.require_scene(&incoming)?;
            (
                scene.preparation,
                scene.take_blockers.clone(),
                scene.revision,
            )
        };

        if let Some(expected_revision) =
            payload.get("incomingSceneRevision").and_then(Value::as_u64)
        {
            if revision != expected_revision {
                return Err(ProtocolError::new(
                    ErrorCode::RevisionMismatch,
                    format!(
                        "replace names incoming revision {expected_revision} but the engine holds {revision} for {incoming}"
                    ),
                ));
            }
        }

        if !matches!(
            preparation,
            PreparationState::Ready | PreparationState::ReadyWithWarnings
        ) || !blockers.is_empty()
        {
            return Err(ProtocolError::new(
                ErrorCode::SceneNotPrepared,
                format!(
                    "scene {incoming} is {} with {} blocker(s): {}; prepare it before replacing Program",
                    preparation.as_str(),
                    blockers.len(),
                    blockers.join("; ")
                ),
            ));
        }

        let warnings = match channel {
            Channel::Program => {
                self.program_scene_id = Some(incoming.clone());
                if let Some(scene) = self.scenes.get_mut(&incoming) {
                    scene.frame = 0;
                    scene.last_used_ms = now_ms();
                }
                self.transition(EngineState::OnAir, "program scene replaced");
                self.start_program_outputs()
            }
            Channel::Preview | Channel::Auxiliary => {
                self.preview_scene_id = Some(incoming.clone());
                self.preview_start_frame = 0;
                self.preview_started_at = Some(Instant::now());
                if let Some(scene) = self.scenes.get_mut(&incoming) {
                    scene.last_used_ms = now_ms();
                }
                Vec::new()
            }
        };

        self.emit(
            "event.channelChanged",
            json!({
                "channel": channel.as_str(),
                "sceneId": incoming,
                "sceneRevision": revision,
                "onAir": channel == Channel::Program,
            }),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.replace", "warnings": warnings }),
        ))
    }

    fn handle_transition(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let transition_id = require_str(payload, "transitionId")?.to_string();
        let duration_frames = payload
            .get("durationFrames")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        // A zero-frame transition is a cut, which is implemented. Anything with a
        // duration needs the transition compositor, which is not.
        if duration_frames > 0 && transition_id != "cut" {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnsupported,
                format!(
                    "transition \"{transition_id}\" over {duration_frames} frames is not implemented; \
                     this engine supports {:?} and will not substitute a cut",
                    self.capabilities.supported_transitions
                ),
            ));
        }

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "playout.transition" }),
        ))
    }

    // -----------------------------------------------------------------------
    // Preview
    // -----------------------------------------------------------------------

    fn handle_preview(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let channel = payload
            .get("channel")
            .and_then(Value::as_str)
            .and_then(Channel::parse)
            .unwrap_or(Channel::Preview);

        // An explicit sceneId wins: a diagnostic or parity client asks for the scene it means,
        // and before this was honoured such a request silently rendered a different one.
        let requested = payload
            .get("sceneId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);

        let scene_id = match requested {
            Some(scene_id) => scene_id,
            // Otherwise the channel's own selection, and nothing else. This used to fall back
            // to `self.scenes.keys().next()` — an arbitrary scene in HashMap order — so a
            // preview with nothing cued showed the operator a scene they had not selected,
            // and which one depended on hash ordering. A refusal is actionable; a confident
            // wrong picture on a confidence monitor is not.
            None => match channel {
                Channel::Program => self.program_scene_id.clone(),
                _ => self.preview_scene_id.clone(),
            }
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCode::SceneNotFound,
                    format!(
                        "no scene is selected on {}; cue one or pass an explicit sceneId",
                        channel.as_str()
                    ),
                )
            })?,
        };

        let stage = self.stage_for_scene(&scene_id)?;
        let source = payload.get("source").unwrap_or(&Value::Null);
        let show_tile_debug = payload
            .get("showTileDebug")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // Renders by the tile-composite route without drawing anything on it, so the two
        // paths can be compared pixel for pixel.
        let force_tiled = payload
            .get("forceTiled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let quality = payload
            .get("quality")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(self.config.preview.default_quality)) as u8;
        // PNG is the lossless option, for anything that measures the picture rather than
        // looking at it.
        let encoding = payload
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or(&self.config.preview.default_encoding)
            .to_string();

        // Fill or key. Broadcast splits transparency into a separate greyscale key signal
        // rather than carrying an alpha channel, and operators check a graphic by looking at
        // that key, so the engine renders it rather than asking a client to derive it.
        let view = preview::PreviewView::parse(payload.get("view").and_then(Value::as_str))?;

        let resolved = preview::resolve_source(&stage, source, self.config.preview.max_pixels)?;

        let frame = payload
            .get("frame")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| self.channel_frame(channel, &scene_id));

        let max_texture_dimension = self.capabilities.limits.max_texture_dimension_2d;

        let gpu = self.gpu.as_ref().cloned().ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::CapabilityUnsupported,
                "this engine has no GPU device, so it cannot render a preview",
            )
        })?;

        // The same caching the Program path needed: without it every preview frame
        // recompiles both shader pipelines, which measured ~500ms and made streaming
        // deliver about two frames a second against a target of eight.
        if self.preview_renderer.is_none() {
            self.preview_renderer = Some(crate::scene_renderer::SceneRenderer::new(
                &gpu,
                resolved.width,
                resolved.height,
            ));
        }
        // Split the borrows: the renderer and the scene live in different fields, and the
        // renderer must be reachable while the scene is mutably borrowed.
        let (cached_renderer, scene) = {
            let renderer = self.preview_renderer.as_mut().expect("set above");
            let scene = self.scenes.get_mut(&scene_id).ok_or_else(|| {
                ProtocolError::new(ErrorCode::SceneNotFound, format!("no scene {scene_id}"))
            })?;
            (Some(renderer), scene)
        };

        let outcome: PreviewOutcome = preview::render_preview(
            &gpu,
            scene,
            &resolved,
            frame,
            quality,
            &encoding,
            view,
            show_tile_debug,
            force_tiled,
            max_texture_dimension,
            cached_renderer,
        )?;

        self.frames_rendered += 1;
        self.last_render_micros = outcome.render_micros;

        let revision = self.scenes.get(&scene_id).map(|s| s.revision);

        Ok((
            "reply.preview".to_string(),
            json!({
                "channel": channel.as_str(),
                "encoding": encoding,
                "view": view.as_str(),
                // Which route rendered it. Reported rather than inferred from the request:
                // a parity comparison that captured the same path twice would prove nothing
                // while looking like a pass.
                "renderPath": if force_tiled
                    || show_tile_debug
                    || resolved.width > self.capabilities.limits.max_texture_dimension_2d
                    || resolved.height > self.capabilities.limits.max_texture_dimension_2d
                {
                    "tiled"
                } else {
                    "single-pass"
                },
                "width": outcome.width,
                "height": outcome.height,
                "frame": frame,
                "sceneId": scene_id,
                "sceneRevision": revision,
                "data": outcome.base64,
                "logicalBounds": {
                    "x": resolved.logical.x,
                    "y": resolved.logical.y,
                    "width": resolved.logical.width,
                    "height": resolved.logical.height,
                },
                "renderScale": resolved.render_scale,
                "renderMs": outcome.render_micros as f64 / 1000.0,
            }),
        ))
    }

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

    /// Register an asset and say whether its bytes are already here.
    ///
    /// The reply's `alreadyCached` is the field that saves the transfer: content addressing
    /// means a logo shared by twenty scenes crosses the wire once.
    fn handle_asset_register(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let asset_id = require_str(payload, "assetId")?.to_string();
        let sha256 = require_str(payload, "sha256")?.to_string();
        let uri = payload.get("uri").and_then(Value::as_str).unwrap_or("");
        let mime_type = payload
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        let size_bytes = payload
            .get("sizeBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        let transport: crate::assets::AssetTransport = payload
            .get("transport")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!(
                        "transport could not be read: {error}. Supported: engine-local, http, \
                         upload, shared-cache"
                    ),
                )
            })?
            .unwrap_or(crate::assets::AssetTransport::Upload);

        let record = self
            .assets
            .register(
                &asset_id,
                &sha256,
                mime_type,
                size_bytes,
                transport,
                uri,
                now_ms(),
            )
            .map_err(asset_error)?;

        tracing::debug!(
            %asset_id, %sha256, ?transport,
            cached = record.is_ready(),
            "asset registered"
        );

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "asset.register",
                "assetId": asset_id,
                // The client skips the upload entirely when this is true.
                "alreadyCached": record.is_ready(),
                "fetchState": record.fetch_state,
                "maxChunkBytes": self.config.assets.max_chunk_bytes,
            }),
        ))
    }

    /// Accept one chunk of an upload.
    ///
    /// Progress is reported after every chunk, including which indices are still missing,
    /// so an interrupted transfer resumes instead of restarting.
    fn handle_asset_upload(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let asset_id = require_str(payload, "assetId")?.to_string();
        let sha256 = require_str(payload, "sha256")?.to_string();
        let chunk_index = payload
            .get("chunkIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ProtocolError::new(ErrorCode::InvalidPayload, "asset.upload needs chunkIndex")
            })? as u32;
        let chunk_count = payload
            .get("chunkCount")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                ProtocolError::new(ErrorCode::InvalidPayload, "asset.upload needs chunkCount")
            })? as u32;
        let total_bytes = payload
            .get("totalBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0);

        let encoded = require_str(payload, "data")?;
        let bytes = base64_decode(encoded).map_err(|error| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("chunk data is not valid base64: {error}"),
            )
        })?;

        let progress = self
            .assets
            .accept_chunk(
                &asset_id,
                &sha256,
                chunk_index,
                chunk_count,
                total_bytes,
                &bytes,
                now_ms(),
            )
            .map_err(asset_error)?;

        if progress.checksum_mismatch {
            // Reported as an error, not a progress update: a client that treated this as
            // "keep going" would wait forever for a transfer that has been discarded.
            return Err(ProtocolError::new(
                ErrorCode::AssetRejected,
                format!(
                    "CHECKSUM_MISMATCH: {}",
                    crate::assets::AssetRejection::ChecksumMismatch.message()
                ),
            ));
        }

        if progress.complete {
            tracing::info!(%asset_id, bytes = progress.received_bytes, "asset upload completed and verified");
            // Any scene blocked on this asset may now be preparable, so re-evaluate.
            self.refresh_asset_blockers();
        }

        Ok(("reply.assetProgress".to_string(), progress.to_payload()))
    }

    /// Re-verify an asset's bytes against its digest.
    fn handle_asset_validate(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let asset_id = require_str(payload, "assetId")?.to_string();
        let validation = self.assets.validate(&asset_id).map_err(asset_error)?;

        // A mismatch is reported as a successful validation with a negative result, not as
        // a protocol error: the client asked a question and got a true answer.
        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "asset.validate",
                "assetId": validation.asset_id,
                "present": validation.present,
                "digestMatches": validation.digest_matches,
                "sizeBytes": validation.size_bytes,
                "message": validation.message,
            }),
        ))
    }

    /// Report readiness for a set of assets.
    ///
    /// Decode-and-upload-to-GPU is deliberately not done here: the renderer uploads what a
    /// frame needs when it prepares, and a second path doing it early would be a second
    /// cache to keep coherent.
    fn handle_asset_preload(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let asset_ids: Vec<String> = payload
            .get("assetIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        if asset_ids.is_empty() {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                "asset.preload needs at least one assetId",
            ));
        }

        let mut ready = Vec::new();
        let mut missing = Vec::new();
        for asset_id in &asset_ids {
            match self.assets.record(asset_id) {
                Some(record) if record.is_ready() => ready.push(asset_id.clone()),
                _ => missing.push(asset_id.clone()),
            }
        }

        let decode_requested = payload
            .get("decode")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut warnings = Vec::new();
        if decode_requested {
            warnings.push(
                "decode was requested; this engine decodes and uploads to the GPU during scene \
                 preparation rather than on preload, so this call only reports readiness"
                    .to_string(),
            );
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "asset.preload",
                "ready": ready,
                "missing": missing,
                "warnings": warnings,
            }),
        ))
    }

    /// Release assets, refusing any a loaded scene still needs.
    fn handle_asset_release(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let asset_ids: Vec<String> = payload
            .get("assetIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let force = payload
            .get("force")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if asset_ids.is_empty() {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                "asset.release needs at least one assetId",
            ));
        }

        let (released, refused) = self.assets.release(&asset_ids, force);

        if force && !released.is_empty() {
            // An operator decision, and an attributable one: forcing a release can put a
            // hole in a scene that is on air.
            tracing::warn!(
                released = released.len(),
                "assets force-released while still referenced"
            );
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "asset.release",
                "released": released,
                "refused": refused
                    .into_iter()
                    .map(|(asset_id, rejection)| json!({
                        "assetId": asset_id,
                        "code": rejection.code(),
                        "message": rejection.message(),
                    }))
                    .collect::<Vec<_>>(),
            }),
        ))
    }

    /// Recompute which scenes are blocked on a missing asset.
    ///
    /// Called when an upload completes. A scene that was refused a take for a missing asset
    /// must become takeable once the bytes arrive, without the client having to reload it.
    fn refresh_asset_blockers(&mut self) {
        let scene_ids: Vec<String> = self.scenes.keys().cloned().collect();
        for scene_id in scene_ids {
            let declared = {
                let Some(scene) = self.scenes.get(&scene_id) else {
                    continue;
                };
                crate::assets::AssetStore::declared_asset_ids(scene.source_document())
            };
            if declared.is_empty() {
                continue;
            }

            let missing = self.assets.reference(&scene_id, &declared, now_ms());
            if let Some(scene) = self.scenes.get_mut(&scene_id) {
                // Rebuilt rather than appended to, so a blocker cannot outlive its cause.
                scene
                    .take_blockers
                    .retain(|blocker| !blocker.starts_with("asset "));
                for asset_id in &missing {
                    scene
                        .take_blockers
                        .push(format!("asset {asset_id} is not available on this engine"));
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Preview streaming
    // -----------------------------------------------------------------------

    /// Register a preview stream.
    ///
    /// The same pixel budget as a one-off preview applies, checked here rather than per
    /// frame: a stream that would breach it must be refused when it is asked for, not
    /// silently deliver nothing thirty times a second.
    fn handle_stream_start(
        &mut self,
        payload: &Value,
        client_id: &str,
    ) -> Result<(String, Value), ProtocolError> {
        let stream_id = require_str(payload, "streamId")?.to_string();
        if let Some(existing) = self.preview_streams.get(&stream_id) {
            // Stream ids are client-owned handles. Reusing another connection's id
            // used to replace its stream and redirect its frames, despite stop and
            // viewport updates correctly enforcing ownership.
            if existing.client_id != client_id {
                return Err(ProtocolError::new(
                    ErrorCode::Unauthorized,
                    format!("preview stream {stream_id} belongs to another client"),
                ));
            }
        }

        let max_streams = self.config.preview.max_streams as usize;
        if !self.preview_streams.contains_key(&stream_id)
            && self.preview_streams.len() >= max_streams
        {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnsupported,
                format!(
                    "this engine serves at most {max_streams} preview streams; stop one before starting another"
                ),
            ));
        }

        let channel = payload
            .get("channel")
            .and_then(Value::as_str)
            .and_then(Channel::parse)
            .unwrap_or(Channel::Preview);

        let encoding = payload
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("jpeg")
            .to_string();
        // Streams stay JPEG. Alpha does not belong in a monitor codec: broadcast carries
        // transparency as a separate greyscale **key** signal, not as an alpha channel (SDI
        // has no alpha at all), and operators monitor the key as a greyscale picture. So a
        // key view is a render mode — see `view` below — not a reason to pay a PNG deflate
        // on every frame. Refused rather than substituted: a client expecting raw frames and
        // handed JPEG decodes garbage.
        if encoding != "jpeg" {
            return Err(ProtocolError::new(
                ErrorCode::CapabilityUnsupported,
                format!(
                    "this engine streams jpeg only; \"{encoding}\" is declared in the protocol but not implemented"
                ),
            ));
        }

        let view = preview::PreviewView::parse(payload.get("view").and_then(Value::as_str))?;

        let requested_fps = payload
            .get("targetFps")
            .and_then(Value::as_f64)
            .unwrap_or(15.0);
        let ceiling = f64::from(self.config.preview.max_stream_fps);
        let target_fps = requested_fps.clamp(1.0, ceiling);

        let source = payload.get("source").cloned().unwrap_or(Value::Null);

        // Validate the source now, against the scene that would be streamed.
        let scene_id = self.channel_scene_id(channel).ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::SceneNotFound,
                format!("no scene is selected on {}", channel.as_str()),
            )
        })?;
        let stage = self.stage_for_scene(&scene_id)?;
        preview::resolve_source(&stage, &source, self.config.preview.max_pixels)?;

        let quality = payload
            .get("quality")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(self.config.preview.default_quality)) as u8;

        let stream = crate::stream::PreviewStream {
            stream_id: stream_id.clone(),
            client_id: client_id.to_string(),
            channel: channel.as_str().to_string(),
            source,
            encoding,
            view,
            quality,
            target_fps,
            show_tile_debug: payload
                .get("showTileDebug")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            frames_sent: 0,
            frames_skipped: 0,
            // Due immediately, so the first frame arrives without waiting an interval.
            next_due_ms: now_ms(),
            last_error: None,
        };

        let interval_ms = stream.interval_ms();
        self.preview_streams.insert(stream_id.clone(), stream);

        tracing::info!(%stream_id, %client_id, target_fps, interval_ms, "preview stream started");

        let mut warnings = Vec::new();
        if requested_fps > ceiling {
            // Said plainly, because the client's animation timing may depend on it.
            warnings.push(format!(
                "requested {requested_fps} fps was clamped to this engine's preview ceiling of {ceiling} fps"
            ));
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "preview.streamStart",
                "streamId": stream_id,
                "targetFps": target_fps,
                "intervalMs": interval_ms,
                "warnings": warnings,
            }),
        ))
    }

    fn handle_stream_stop(
        &mut self,
        payload: &Value,
        client_id: &str,
    ) -> Result<(String, Value), ProtocolError> {
        let stream_id = require_str(payload, "streamId")?.to_string();

        let Some(stream) = self.preview_streams.get(&stream_id) else {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("no preview stream {stream_id}"),
            ));
        };
        // One client must not be able to stop another's stream.
        if stream.client_id != client_id {
            return Err(ProtocolError::new(
                ErrorCode::Unauthorized,
                format!("preview stream {stream_id} belongs to another client"),
            ));
        }

        let stream = self
            .preview_streams
            .remove(&stream_id)
            .expect("checked above");
        tracing::info!(%stream_id, frames = stream.frames_sent, "preview stream stopped");

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "preview.streamStop",
                "streamId": stream_id,
                "framesSent": stream.frames_sent,
                "framesSkipped": stream.frames_skipped,
            }),
        ))
    }

    /// Repoint a running stream at a different region.
    ///
    /// The reason this exists rather than stop-and-start: panning a viewport should not
    /// drop frames, and a restart would lose the cadence and the stream id the client is
    /// already keyed on.
    fn handle_stream_set_viewport(
        &mut self,
        payload: &Value,
        client_id: &str,
    ) -> Result<(String, Value), ProtocolError> {
        let stream_id = require_str(payload, "streamId")?.to_string();
        let source = payload.get("source").cloned().ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                "preview.setViewport needs a source",
            )
        })?;

        let Some(existing) = self.preview_streams.get(&stream_id) else {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("no preview stream {stream_id}"),
            ));
        };
        if existing.client_id != client_id {
            return Err(ProtocolError::new(
                ErrorCode::Unauthorized,
                format!("preview stream {stream_id} belongs to another client"),
            ));
        }

        let channel = Channel::parse(&existing.channel).unwrap_or(Channel::Preview);
        let scene_id = self.channel_scene_id(channel).ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::SceneNotFound,
                format!("no scene is selected on {}", channel.as_str()),
            )
        })?;
        let stage = self.stage_for_scene(&scene_id)?;
        // Checked before it is stored: a stream must never be left pointing at a region
        // it cannot render.
        let resolved = preview::resolve_source(&stage, &source, self.config.preview.max_pixels)?;

        if let Some(stream) = self.preview_streams.get_mut(&stream_id) {
            stream.source = source;
            stream.last_error = None;
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "preview.setViewport",
                "streamId": stream_id,
                "width": resolved.width,
                "height": resolved.height,
                "renderScale": resolved.render_scale,
            }),
        ))
    }

    /// True when at least one stream is registered.
    pub fn has_preview_streams(&self) -> bool {
        !self.preview_streams.is_empty()
    }

    /// Milliseconds until the earliest stream is due; 0 when one is due now.
    pub fn next_stream_wait_ms(&self) -> u64 {
        let now = now_ms();
        self.preview_streams
            .values()
            .map(|stream| stream.next_due_ms.saturating_sub(now))
            .min()
            .unwrap_or(u64::MAX)
    }

    /// Drop every stream belonging to a client that has gone.
    ///
    /// Without this a reconnecting Editor accumulates streams that render frames nobody
    /// receives — GPU time spent on nothing.
    pub fn drop_streams_for_client(&mut self, client_id: &str) -> usize {
        let before = self.preview_streams.len();
        self.preview_streams
            .retain(|_, stream| stream.client_id != client_id);
        let dropped = before - self.preview_streams.len();
        if dropped > 0 {
            tracing::info!(%client_id, dropped, "dropped preview streams for a departed client");
        }
        dropped
    }

    /// Render every stream that is due. Returns how many frames were delivered.
    ///
    /// Called from the streamer task on a blocking thread. A stream that fails records
    /// the reason and keeps its schedule: a transient failure must not silently stop a
    /// preview an operator is watching.
    pub fn render_due_preview_streams(&mut self) -> usize {
        let now = now_ms();
        let due: Vec<String> = self
            .preview_streams
            .iter()
            .filter(|(_, stream)| stream.next_due_ms <= now)
            .map(|(id, _)| id.clone())
            .collect();

        let mut delivered = 0usize;
        for stream_id in due {
            match self.render_stream_frame(&stream_id) {
                Ok(Some((client_id, payload))) => {
                    self.emit_to(Some(client_id), "event.previewFrame", payload);
                    delivered += 1;
                }
                Ok(None) => {}
                Err(error) => {
                    if let Some(stream) = self.preview_streams.get_mut(&stream_id) {
                        stream.frames_skipped += 1;
                        // Logged once per transition into failure rather than every
                        // frame: a broken stream at 30 fps would drown the log.
                        let first_failure = stream.last_error.is_none();
                        stream.last_error = Some(error.clone());
                        if first_failure {
                            tracing::warn!(%stream_id, %error, "preview stream frame failed");
                        }
                    }
                }
            }
        }

        delivered
    }

    /// Render one stream's frame, advancing its schedule.
    fn render_stream_frame(&mut self, stream_id: &str) -> Result<Option<(String, Value)>, String> {
        let Some(stream) = self.preview_streams.get(stream_id).cloned() else {
            return Ok(None);
        };

        // Reschedule first, so a slow or failing frame cannot make the stream due
        // forever and starve the others.
        let interval = stream.interval_ms();
        if let Some(entry) = self.preview_streams.get_mut(stream_id) {
            let now = now_ms();
            // Absolute where possible, so the cadence does not drift; jumped forward
            // when a render overran, so a backlog is dropped rather than chased.
            entry.next_due_ms = (entry.next_due_ms + interval).max(now.saturating_sub(interval));
            if entry.next_due_ms <= now {
                entry.next_due_ms = now + interval;
            }
        }

        let channel = Channel::parse(&stream.channel).unwrap_or(Channel::Preview);
        let scene_id = self
            .channel_scene_id(channel)
            .ok_or_else(|| format!("no scene is on {}", channel.as_str()))?;

        let stage = self
            .stage_for_scene(&scene_id)
            .map_err(|error| error.message.clone())?;
        let resolved =
            preview::resolve_source(&stage, &stream.source, self.config.preview.max_pixels)
                .map_err(|error| error.message.clone())?;

        let gpu = self
            .gpu
            .as_ref()
            .cloned()
            .ok_or_else(|| "this engine has no GPU device".to_string())?;
        let max_texture_dimension = self.capabilities.limits.max_texture_dimension_2d;

        if self.preview_renderer.is_none() {
            self.preview_renderer = Some(crate::scene_renderer::SceneRenderer::new(
                &gpu,
                resolved.width,
                resolved.height,
            ));
        }

        // The whole reason streaming is viable: the pipelines, target and prepared scene
        // survive between frames. Building them per frame cost ~500ms, which delivered
        // about two frames a second against a target of eight.
        let frame = self.channel_frame(channel, &scene_id);
        let (cached_renderer, scene) = {
            let renderer = self.preview_renderer.as_mut().expect("set above");
            let scene = self
                .scenes
                .get_mut(&scene_id)
                .ok_or_else(|| format!("no scene {scene_id}"))?;
            (Some(renderer), scene)
        };
        let revision = scene.revision;

        let outcome = preview::render_preview(
            &gpu,
            scene,
            &resolved,
            frame,
            stream.quality,
            // Streams are jpeg only: a stream of PNGs at 30fps is bandwidth spent on
            // precision nobody is measuring.
            "jpeg",
            stream.view,
            stream.show_tile_debug,
            false,
            max_texture_dimension,
            cached_renderer,
        )
        .map_err(|error| error.message.clone())?;

        self.frames_rendered += 1;
        self.last_render_micros = outcome.render_micros;

        if let Some(entry) = self.preview_streams.get_mut(stream_id) {
            entry.frames_sent += 1;
            entry.last_error = None;
        }

        Ok(Some((
            stream.client_id.clone(),
            json!({
                "channel": stream.channel,
                "streamId": stream.stream_id,
                "encoding": "jpeg",
                "view": stream.view.as_str(),
                "width": outcome.width,
                "height": outcome.height,
                "frame": frame,
                "sceneId": scene_id,
                "sceneRevision": revision,
                "data": outcome.base64,
                "logicalBounds": {
                    "x": resolved.logical.x,
                    "y": resolved.logical.y,
                    "width": resolved.logical.width,
                    "height": resolved.logical.height,
                },
                "renderScale": resolved.render_scale,
                "renderMs": outcome.render_micros as f64 / 1000.0,
            }),
        )))
    }

    /// The scene currently on a channel.
    fn channel_scene_id(&self, channel: Channel) -> Option<String> {
        match channel {
            Channel::Program => self.program_scene_id.clone(),
            _ => self
                .preview_scene_id
                .clone()
                .or_else(|| self.scenes.keys().next().cloned()),
        }
    }

    // -----------------------------------------------------------------------
    // Renderer restart
    // -----------------------------------------------------------------------

    /// Rebuild the render state without restarting the process.
    ///
    /// What this is for: recovering from a device loss or a corrupted pipeline cache
    /// without dropping the connection, the loaded scenes, or Program.
    ///
    /// What it deliberately does *not* do is re-acquire the GPU device. A wgpu device
    /// cannot be replaced under a running `Arc<GpuContext>` without invalidating every
    /// handle derived from it, and pretending otherwise would produce a renderer that
    /// looks restarted and renders nothing. A genuine device loss therefore still needs
    /// the process restarted, and this says so rather than reporting success.
    fn handle_restart_renderer(
        &mut self,
        payload: &Value,
        client_id: &str,
    ) -> Result<(String, Value), ProtocolError> {
        let reason = payload
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        let preserve_program = payload
            .get("preserveProgram")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let program_scene = self.program_scene_id.clone();
        let was_on_air = program_scene.is_some();

        // Program comes off air for the rebuild unless the caller asked to keep it. An
        // operator who did not ask must not have air interrupted silently.
        if was_on_air && !preserve_program {
            self.program_scene_id = None;
            self.stop_program_outputs();
        }

        self.transition(EngineState::Recovering, "renderer restart requested");

        // Drop both renderers: their pipelines, targets and cached scenes are exactly
        // what a restart is meant to rebuild. The next frame builds them again.
        // Leaving the preview one in place would half-restart the engine and leave the
        // suspect state exactly where it was.
        self.program_renderer = None;
        self.preview_renderer = None;

        // Every tile cache and prepared document is rebuilt too.
        let mut scenes_reset = 0;
        for scene in self.scenes.values_mut() {
            scene.builder.clear();
            scene.tiles.mark_all_dirty();
            scene.prepared_tile_count = 0;
            // Back to loading, not ready: the GPU resources a prepare produced are
            // gone, and a scene that claimed to be ready would pass the Take gate while
            // having nothing built.
            scene.preparation = PreparationState::Loading;
            scenes_reset += 1;
        }

        self.renderer_restarts += 1;
        self.errors.clear();

        let next_state = if was_on_air && preserve_program {
            EngineState::OnAir
        } else {
            EngineState::Ready
        };
        self.transition(next_state, "renderer restarted");

        tracing::warn!(
            %client_id, %reason, preserve_program, scenes_reset,
            "renderer restarted in process"
        );

        self.emit(
            "event.warning",
            json!({
                "code": "RENDERER_RESTARTED",
                "message": format!("the renderer was rebuilt in process: {reason}"),
                "scenesReset": scenes_reset,
            }),
        );

        let mut warnings = vec![
            "scenes must be prepared again before they can be taken; their tile caches were cleared"
                .to_string(),
        ];
        // Never claimed as a device recovery, because it is not one.
        warnings.push(
            "this rebuilds render state on the existing GPU device; it does not re-acquire the \
             device, so a genuine device loss still needs the engine process restarted"
                .to_string(),
        );
        if was_on_air && preserve_program {
            warnings.push(
                "Program was kept on air across the restart and its first frame after this will \
                 pay for pipeline compilation"
                    .to_string(),
            );
        }

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "engine.restartRenderer",
                "scenesReset": scenes_reset,
                "programPreserved": was_on_air && preserve_program,
                "rendererRestarts": self.renderer_restarts,
                "warnings": warnings,
            }),
        ))
    }

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    /// Every output instance plus every adapter this engine could instantiate.
    ///
    /// The adapter list matters as much as the instance list: an operator needs to
    /// see that NDI exists and *why* it is unavailable, not merely that it is
    /// absent.
    pub fn outputs_payload(&self) -> Value {
        let statuses: Vec<OutputStatus> = self.outputs.iter().map(|o| o.status()).collect();

        let cache = std::path::PathBuf::from(&self.config.assets.cache_directory);
        let mut adapters = Vec::new();
        for adapter_id in ["null", "virtual", "recording", "ndi", "decklink", "aja"] {
            match outputs::create_sink_with_ndi_pool_slots(
                adapter_id,
                &cache,
                &Value::Null,
                self.config.outputs.ndi_frame_pool_slots,
            ) {
                Ok(sink) => adapters.push(json!({
                    "adapterId": sink.adapter_id(),
                    "name": sink.name(),
                    "live": sink.is_live(),
                    "available": sink.available(),
                    "unavailableReason": sink.unavailable_reason(),
                    "hardwareCertified": sink.hardware_certified(),
                })),
                Err(_) => continue,
            }
        }

        json!({ "outputs": statuses, "availableAdapters": adapters })
    }

    fn handle_output_configure(
        &mut self,
        payload: &Value,
    ) -> Result<(String, Value), ProtocolError> {
        let output_id = require_str(payload, "outputId")?.to_string();
        let adapter_id = require_str(payload, "adapterId")?.to_string();

        if self.outputs.len() >= self.config.stage.max_outputs as usize
            && !self.outputs.iter().any(|o| o.output_id == output_id)
        {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!(
                    "engine supports {} outputs; remove one before adding another",
                    self.config.stage.max_outputs
                ),
            ));
        }

        // Only adapters the operator enabled in configuration may be instantiated.
        // A client must not be able to conjure a live output the deployment did not
        // sanction.
        if !self
            .config
            .outputs
            .enabled_adapters
            .iter()
            .any(|enabled| enabled == &adapter_id)
        {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!(
                    "adapter \"{adapter_id}\" is not enabled on this engine; enabled adapters are {:?}",
                    self.config.outputs.enabled_adapters
                ),
            ));
        }

        let format: OutputFormat = payload
            .get("format")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("output format could not be parsed: {error}"),
                )
            })?
            .unwrap_or_default();

        if format.width == 0 || format.height == 0 {
            return Err(ProtocolError::new(
                ErrorCode::InvalidPayload,
                "output width and height must be positive",
            ));
        }
        let limit = self.capabilities.limits.max_texture_dimension_2d;
        if format.width > limit || format.height > limit {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!(
                    "output {}x{} exceeds the engine's {limit}px render limit; use a region mapping",
                    format.width, format.height
                ),
            ));
        }



        // NDI owns a fixed sender/pool generation while it is running. Replacing
        // it would change its network source or format underneath Program, so
        // Playout must take it offline before a reconfiguration.
        if self.outputs.iter().any(|output| {
            output.output_id == output_id && output.adapter_id() == "ndi" && output.is_running()
        }) {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!(
                    "NDI output \"{output_id}\" is running; take it offline before changing sourceName or format"
                ),
            ));
        }

        let options = payload.get("options").cloned().unwrap_or(Value::Null);
        if adapter_id == "ndi" {
            outputs::validate_ndi_options(&options)
                .map_err(|error| ProtocolError::new(ErrorCode::InvalidPayload, error))?;
        }
        let cache = std::path::PathBuf::from(&self.config.assets.cache_directory);
        let sink = outputs::create_sink_with_ndi_pool_slots(
            &adapter_id,
            &cache,
            &options,
            self.config.outputs.ndi_frame_pool_slots,
        )
        .map_err(|error| ProtocolError::new(ErrorCode::OutputError, error))?;

        let live = sink.is_live();
        let certified = sink.hardware_certified();

        // Replacing an existing instance stops it first, so a running output is
        // never silently reconfigured underneath itself.
        if let Some(existing) = self.outputs.iter_mut().find(|o| o.output_id == output_id) {
            existing.stop();
        }
        self.outputs.retain(|o| o.output_id != output_id);

        let mut instance = OutputInstance::new(output_id.clone(), sink);
        let mut warnings = instance
            .configure(format)
            .map_err(|error| ProtocolError::new(ErrorCode::OutputError, error))?;

        if live && !certified {
            warnings.push(format!(
                "output \"{output_id}\" is a live adapter that has not been certified against hardware; do not rely on it for a show"
            ));
        }

        let status = instance.status();
        self.outputs.push(instance);

        tracing::info!(
            %output_id, %adapter_id, live, certified,
            width = status.width, height = status.height,
            "output configured"
        );

        self.emit(
            "event.outputHealth",
            serde_json::to_value(&status).unwrap_or(Value::Null),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "output.configure", "warnings": warnings }),
        ))
    }

    fn handle_output_start(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let output_id = require_str(payload, "outputId")?.to_string();

        let instance = self
            .outputs
            .iter_mut()
            .find(|o| o.output_id == output_id)
            .ok_or_else(|| {
                ProtocolError::new(ErrorCode::OutputError, format!("no output {output_id}"))
            })?;

        instance
            .start()
            .map_err(|error| ProtocolError::new(ErrorCode::OutputError, error))?;

        let status = instance.status();
        let live = status.live;
        tracing::info!(%output_id, live, "output started");

        self.emit(
            "event.outputHealth",
            serde_json::to_value(&status).unwrap_or(Value::Null),
        );

        Ok((
            "reply.ack".to_string(),
            json!({
                "requestType": "output.start",
                "warnings": if live {
                    vec![format!("output \"{output_id}\" is live; frames now reach an audience")]
                } else {
                    Vec::<String>::new()
                }
            }),
        ))
    }

    fn handle_output_stop(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let output_id = require_str(payload, "outputId")?.to_string();

        let instance = self
            .outputs
            .iter_mut()
            .find(|o| o.output_id == output_id)
            .ok_or_else(|| {
                ProtocolError::new(ErrorCode::OutputError, format!("no output {output_id}"))
            })?;

        instance.stop();
        let status = instance.status();
        tracing::info!(%output_id, "output stopped");

        self.emit(
            "event.outputHealth",
            serde_json::to_value(&status).unwrap_or(Value::Null),
        );

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "output.stop" }),
        ))
    }

    fn handle_output_remove(&mut self, payload: &Value) -> Result<(String, Value), ProtocolError> {
        let output_id = require_str(payload, "outputId")?.to_string();

        let Some(position) = self.outputs.iter().position(|o| o.output_id == output_id) else {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!("no output {output_id}"),
            ));
        };

        // Removing a running live output would drop air without saying so.
        if self.outputs[position].is_running() && self.outputs[position].is_live() {
            return Err(ProtocolError::new(
                ErrorCode::OutputError,
                format!("output {output_id} is live and running; stop it before removing it"),
            ));
        }

        self.outputs[position].stop();
        self.outputs.remove(position);

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "output.remove" }),
        ))
    }

    /// Start every configured output, because something has just gone on air.
    ///
    /// Returns operator-facing notes. Two things must be unmistakable in them: which
    /// outputs are actually reaching an audience, and whether anything failed. A take
    /// with no output at all is called out explicitly - the engine is then rendering
    /// into nothing, which looks identical to a healthy take in every other respect.
    fn start_program_outputs(&mut self) -> Vec<String> {
        let mut notes = Vec::new();
        let mut live = Vec::new();
        let mut headless = Vec::new();
        let mut failed = Vec::new();

        for output in &mut self.outputs {
            if output.is_running() {
                if output.is_live() {
                    live.push(output.output_id.clone());
                } else {
                    headless.push(output.output_id.clone());
                }
                continue;
            }

            if output.state == crate::outputs::OutputState::Idle {
                // Never started implicitly: an unconfigured output has no format, so
                // it has no idea what it would be transmitting.
                failed.push(format!(
                    "{} was not configured, so it did not start",
                    output.output_id
                ));
                continue;
            }

            match output.start() {
                Ok(()) => {
                    if output.is_live() {
                        live.push(output.output_id.clone());
                    } else {
                        headless.push(output.output_id.clone());
                    }
                }
                // One output failing must not stop the take: the others may well be
                // the ones carrying the show.
                Err(error) => failed.push(format!("{} failed to start: {error}", output.output_id)),
            }
        }

        if !live.is_empty() {
            notes.push(format!("live on air via {}", live.join(", ")));
        }
        if !headless.is_empty() {
            notes.push(format!(
                "rendering headlessly to {} (not live)",
                headless.join(", ")
            ));
        }
        for failure in &failed {
            notes.push(failure.clone());
        }

        if live.is_empty() && headless.is_empty() {
            notes.push(
                "no output is running, so this take is not being rendered anywhere; configure an \
                 output (\"virtual\" renders it headlessly without going live)"
                    .to_string(),
            );
        } else if live.is_empty() {
            notes.push(
                "no live output is running, so nothing from this take reaches air".to_string(),
            );
        }

        tracing::info!(
            live = live.len(),
            headless = headless.len(),
            failed = failed.len(),
            "program outputs started"
        );

        notes
    }

    /// Stop every running output. Returns how many were stopped.
    fn stop_program_outputs(&mut self) -> usize {
        let mut stopped = 0;
        for output in &mut self.outputs {
            if output.is_running() {
                output.stop();
                stopped += 1;
            }
        }
        if stopped > 0 {
            tracing::info!(stopped, "program outputs stopped");
        }
        stopped
    }

    /// How many running outputs are actually reaching an audience.
    fn live_output_count(&self) -> usize {
        self.outputs
            .iter()
            .filter(|output| output.is_running() && output.is_live())
            .count()
    }

    /// Outputs that are running, split by whether they reach an audience.
    pub fn running_output_summary(&self) -> (usize, usize) {
        let live = self
            .outputs
            .iter()
            .filter(|o| o.is_running() && o.is_live())
            .count();
        let offline = self
            .outputs
            .iter()
            .filter(|o| o.is_running() && !o.is_live())
            .count();
        (live, offline)
    }

    pub fn has_running_outputs(&self) -> bool {
        self.outputs.iter().any(OutputInstance::is_running)
    }

    /// Is there a scene whose animation should be running?
    ///
    /// Deliberately independent of outputs. An operator has to be able to confirm a
    /// graphic on the Preview and Program monitors *before* an SDI or NDI output exists,
    /// so the playhead runs whenever something is on air, not only when it transmits.
    pub fn has_program_scene(&self) -> bool {
        self.program_scene_id.is_some()
    }

    /// Advance the Program playhead by the frames that have actually elapsed.
    ///
    /// Program output and its monitor sample `LoadedScene::frame`; the dedicated Preview
    /// playhead is independent so cueing can restart Preview without touching air.
    ///
    /// `elapsed` rather than an absolute frame number, so each scene's animation is timed
    /// from its own take rather than from engine start, and a dropped frame advances the
    /// animation by the time that really passed instead of playing it in slow motion.
    pub fn advance_program_playhead(&mut self, elapsed: u64) {
        if elapsed == 0 {
            return;
        }
        let Some(scene_id) = self.program_scene_id.as_deref() else {
            return;
        };
        if let Some(scene) = self.scenes.get_mut(scene_id) {
            scene.frame = scene.frame.saturating_add(elapsed);
        }
    }

    /// Render one Program frame and hand it to every running output.
    ///
    /// Called from the Program clock. The steady path copies no scene/stage
    /// document or output strings; preparation remains exceptional work.
    pub fn render_program_frame(&mut self, frame: u64) -> Result<usize, String> {
        if !self.has_running_outputs() {
            return Ok(0);
        }

        let Some(scene_id) = self.program_scene_id.as_deref() else {
            return Ok(0);
        };
        let gpu = self
            .gpu
            .as_ref()
            .cloned()
            .ok_or_else(|| "engine has no GPU device".to_string())?;

        // The output format is static while an output is running. Copy only the
        // dimensions instead of cloning its colour-space string on each tick.
        let (output_width, output_height) = self
            .outputs
            .iter()
            .find(|output| output.is_running())
            .map(|output| (output.format.width, output.format.height))
            .unwrap_or((1920, 1080));
        let bounds = self
            .stage_for_scene_ref(scene_id)
            .map_err(|error| error.message.clone())?
            .bounds();
        let revision = self
            .scenes
            .get(scene_id)
            .map(|scene| scene.revision)
            .unwrap_or(0);
        let started = std::time::Instant::now();

        if self.program_renderer.is_none() {
            self.program_renderer = Some(crate::scene_renderer::SceneRenderer::new(
                &gpu,
                output_width,
                output_height,
            ));
        }

        let bounds_tuple = (bounds.x, bounds.y, bounds.width, bounds.height);
        let document = if self
            .program_renderer
            .as_ref()
            .expect("set above")
            .needs_prepare(scene_id, revision, bounds_tuple)
        {
            Some(
                self.scenes
                    .get(scene_id)
                    .ok_or_else(|| format!("no scene {scene_id}"))?
                    .source_document()
                    .clone(),
            )
        } else {
            None
        };

        let renderer = self.program_renderer.as_mut().expect("set above");
        renderer.resize(&gpu, output_width, output_height);
        let origin = crate::stage::Point::new(bounds.x, bounds.y);
        let video = renderer.render(&gpu, scene_id, revision, bounds_tuple, frame, || {
            // Only runs after an invalidation or revision change, never on a
            // steady render tick.
            let document = document.ok_or_else(|| {
                "program scene needs re-preparing but the document was not captured".to_string()
            })?;
            let animation = crate::animation::SceneAnimation::from_document(&document);
            let rebased =
                crate::render::rebase_scene_json(&document, origin, bounds.width, bounds.height);
            let prepared = grapix_render_core::scene::prepare_scene(&rebased)
                .map_err(|error| format!("program scene preparation failed: {error}"))?;
            Ok((prepared, animation))
        })?;

        self.frames_rendered += 1;
        self.last_render_micros = started.elapsed().as_micros() as u64;
        self.clear_program_error();

        let mut delivered = 0usize;
        let mut output_error = false;
        for output in self.outputs.iter_mut() {
            if !output.is_running() {
                continue;
            }
            if output.send(&video) {
                delivered += 1;
            }
            output_error |= output.is_error();
        }

        // Status construction clones adapter strings, so it is deliberately
        // exceptional work rather than an allocation made by every frame.
        if output_error {
            for index in 0..self.outputs.len() {
                if self.outputs[index].is_error() {
                    let status = self.outputs[index].status();
                    self.emit(
                        "event.outputHealth",
                        serde_json::to_value(&status).unwrap_or(Value::Null),
                    );
                }
            }
        }
        Ok(delivered)
    }

    /// Record frames the Program clock skipped because a render overran.
    ///
    /// Dropping is the correct response — catching up would play the show in slow
    /// motion — but it has to be counted and visible, or a struggling engine looks
    /// healthy.
    pub fn note_dropped_program_frames(&mut self, dropped: u64) {
        if dropped == 0 {
            return;
        }
        self.frames_dropped += dropped;
        self.frames_late += 1;
    }

    /// Surface a repeated Program render failure in status.
    ///
    /// Only becomes an engine error once it is clearly persistent: a single failed
    /// frame is a glitch, a hundred is a broken renderer.
    pub fn note_program_error(&mut self, error: &str, consecutive: u32) {
        let message = format!("program render failed ({consecutive} consecutive): {error}");

        if consecutive >= 4 {
            if !self
                .errors
                .iter()
                .any(|existing| existing.starts_with("program render failed"))
            {
                self.errors.push(message);
            }
            self.transition(EngineState::Warning, "program frames are failing");
        }
    }

    /// Clear a Program error once frames succeed again.
    pub fn clear_program_error(&mut self) {
        self.errors
            .retain(|existing| !existing.starts_with("program render failed"));
    }

    /// The Program frame rate. A running output is authoritative; before an output exists,
    /// use the on-air scene's authored rate so Preview and Program animation timing agree.
    pub fn program_frame_rate(&self) -> crate::stage::FrameRate {
        self.outputs
            .iter()
            .find(|o| o.is_running())
            .map(|o| o.format.frame_rate)
            .or_else(|| {
                self.program_scene_id
                    .as_deref()
                    .and_then(|scene_id| self.scene_frame_rate(scene_id))
            })
            .unwrap_or_default()
    }

    /// Current animation frame for a channel.
    ///
    /// Preview is derived from elapsed monotonic time at the scene's authored rational rate.
    /// This keeps motion correct even when the MJPEG monitor is capped below Program fps:
    /// stream cadence controls how often a sample is sent, not how quickly animation runs.
    pub fn channel_frame(&self, channel: Channel, scene_id: &str) -> u64 {
        if channel == Channel::Program {
            return self
                .scenes
                .get(scene_id)
                .map(|scene| scene.frame)
                .unwrap_or(0);
        }

        let elapsed_ns = self
            .preview_started_at
            .map(|started| started.elapsed().as_nanos())
            .unwrap_or(0);
        let rate = self.scene_frame_rate(scene_id).unwrap_or_default();
        let denominator = u128::from(rate.denominator.max(1)) * 1_000_000_000;
        let elapsed_frames = elapsed_ns.saturating_mul(u128::from(rate.numerator)) / denominator;
        self.preview_start_frame
            .saturating_add(elapsed_frames.min(u128::from(u64::MAX)) as u64)
    }

    fn scene_frame_rate(&self, scene_id: &str) -> Option<crate::stage::FrameRate> {
        let timeline = self
            .scenes
            .get(scene_id)?
            .source_document()
            .get("timeline")?;
        if let Some(rate) = timeline.get("frameRate") {
            let numerator: u32 = rate.get("numerator")?.as_u64()?.try_into().ok()?;
            let denominator: u32 = rate
                .get("denominator")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .try_into()
                .ok()?;
            return Some(crate::stage::FrameRate {
                numerator,
                denominator: denominator.max(1),
            });
        }

        let fps = timeline.get("fps")?.as_f64()?;
        if !fps.is_finite() || fps <= 0.0 {
            return None;
        }
        Some(crate::stage::FrameRate {
            numerator: (fps * 1_000.0).round().clamp(1.0, u32::MAX as f64) as u32,
            denominator: 1_000,
        })
    }

    // -----------------------------------------------------------------------
    // Configuration and status
    // -----------------------------------------------------------------------

    fn handle_set_configuration(
        &mut self,
        payload: &Value,
    ) -> Result<(String, Value), ProtocolError> {
        let mut applied = Vec::new();

        if let Some(bytes) = payload.get("tileCacheBudgetBytes").and_then(Value::as_u64) {
            self.config.stage.tile_cache_budget_bytes = bytes.max(1024 * 1024);
            applied.push("tileCacheBudgetBytes");
        }
        if let Some(bytes) = payload.get("gpuMemoryBudgetBytes").and_then(Value::as_u64) {
            self.config.gpu.memory_budget_bytes = bytes;
            applied.push("gpuMemoryBudgetBytes");
        }
        if let Some(enabled) = payload.get("diagnosticsEnabled").and_then(Value::as_bool) {
            self.config.diagnostics.enabled = enabled;
            applied.push("diagnosticsEnabled");
        }

        Ok((
            "reply.ack".to_string(),
            json!({ "requestType": "engine.setConfiguration", "warnings": [
                format!("applied {applied:?}; quality profiles and log level are not runtime-adjustable in this build")
            ] }),
        ))
    }

    /// Full status, and diagnostics when `include_tiles` is set.
    pub fn status_payload(&self, include_tiles: bool) -> Value {
        let program_stage = self
            .program_scene_id
            .as_ref()
            .or(self.preview_scene_id.as_ref())
            .and_then(|scene_id| self.stage_for_scene(scene_id).ok());

        let stage =
            program_stage.unwrap_or_else(|| StageDocument::implicit("stage_none", 1920.0, 1080.0));

        let (
            mut tracked,
            mut active,
            mut dirty,
            mut resident,
            mut evicted,
            mut pinned,
            mut cache_bytes,
        ) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0u64);

        let mut tile_detail = Vec::new();

        for scene in self.scenes.values() {
            let stats = scene.tiles.stats();
            tracked += stats.tracked_tiles;
            active += stats.rendered_tiles;
            dirty += stats.dirty_tiles;
            resident += stats.resident_tiles;
            evicted += stats.evicted_tiles;
            pinned += stats.pinned_tiles;
            cache_bytes += stats.cache_bytes;

            if include_tiles {
                for tile in scene.tiles.tracked_tiles() {
                    tile_detail.push(json!({
                        "tileId": tile.tile_id,
                        "column": tile.column,
                        "row": tile.row,
                        "dirty": tile.dirty,
                        "renderState": format!("{:?}", tile.render_state).to_lowercase(),
                        "gpuState": format!("{:?}", tile.gpu_state).to_lowercase(),
                        "cacheState": format!("{:?}", tile.cache_state).to_lowercase(),
                        "lastRenderedFrame": tile.last_rendered_frame,
                        "activeObjectCount": tile.active_object_ids.len(),
                        "requiredOverscan": tile.required_overscan,
                        "estimatedBytes": tile.estimated_bytes,
                    }));
                }
            }
        }

        let scenes: Vec<Value> = self
            .scenes
            .values()
            .map(|scene| {
                let channel = if self.program_scene_id.as_deref() == Some(scene.scene_id.as_str()) {
                    Value::String("program".to_string())
                } else if self.preview_scene_id.as_deref() == Some(scene.scene_id.as_str()) {
                    Value::String("preview".to_string())
                } else {
                    Value::Null
                };

                json!({
                    "sceneId": scene.scene_id,
                    "name": scene.name,
                    "revision": scene.revision,
                    "preparationState": scene.preparation.as_str(),
                    "channel": channel,
                    // Where this scene's animation has reached. Reported because a frozen
                    // playhead is invisible otherwise: the renderer animates correctly and
                    // the monitors still show one still frame.
                    "frame": scene.frame,
                    "objectCount": scene.object_count,
                    "preparedTileCount": scene.prepared_tile_count,
                    "estimatedBytes": scene.tiles.stats().cache_bytes,
                    "warnings": scene.warnings,
                    "takeReady": scene.take_blockers.is_empty()
                        && matches!(
                            scene.preparation,
                            PreparationState::Ready | PreparationState::ReadyWithWarnings
                        ),
                    "takeBlockers": scene.take_blockers,
                    "lastUsedMs": scene.last_used_ms,
                })
            })
            .collect();

        let tiling = self.tiling_for(&stage);
        let grid = TileGrid::new(&stage.canvas, &tiling);

        let active_viewport = stage
            .viewports
            .iter()
            .find(|viewport| viewport.enabled)
            .map(|viewport| stage.viewport_render_size(viewport))
            .unwrap_or((0, 0));

        let mut status = json!({
            "engineId": self.engine_id,
            "engineName": self.config.identity.name,
            "address": format!("{}:{}", self.config.network.bind_address, self.config.network.websocket_port),
            "softwareVersion": self.capabilities.software_version,
            "state": self.state.state().as_str(),
            "uptimeMs": self.started_at.elapsed().as_millis() as u64,
            "qualityProfile": "PROGRAM_HD",
            "headless": self.config.gpu.headless,
            "stage": {
                "stageId": stage.stage_id,
                "logicalWidth": stage.canvas.logical_width,
                "logicalHeight": stage.canvas.logical_height,
                // Reported so an operator can see what tiling avoids allocating.
                "fullResolutionBytes": stage.canvas.full_resolution_bytes(),
                "surfaceCount": stage.surfaces.len(),
                "viewportCount": stage.viewports.len(),
                "activeViewportWidth": active_viewport.0,
                "activeViewportHeight": active_viewport.1,
                "tilingEnabled": stage.tiling.enabled,
            },
            "scenes": scenes,
            "previewStreams": self
                .preview_streams
                .values()
                .map(|stream| stream.status())
                .collect::<Vec<_>>(),
            "rendererRestarts": self.renderer_restarts,
            // Reported next to `resyncCount`: a client silently resyncing every edit
            // instead of patching is losing the whole point, and the ratio shows it.
            "patchesApplied": self.patches_applied,
            "previewSceneId": self.preview_scene_id,
            "programSceneId": self.program_scene_id,
            "previewFrame": self.preview_scene_id
                .as_deref()
                .map(|scene_id| self.channel_frame(Channel::Preview, scene_id)),
            "tiles": {
                "gridColumns": grid.columns,
                "gridRows": grid.rows,
                // The grid this stage implies, so it agrees with the columns and rows beside it.
                // Summing every loaded scene's grid here reported 126 for a 25x5 stage, because a
                // second small scene contributed its own single tile to a number labelled as the
                // stage's. The occupancy counts below are genuinely cross-scene: they describe
                // what the cache is holding, not what the stage is divided into.
                "totalTiles": grid.tile_count(),
                "trackedTiles": tracked,
                "activeTiles": active,
                "dirtyTiles": dirty,
                "residentTiles": resident,
                "evictedTiles": evicted,
                "pinnedTiles": pinned,
                "cacheBytes": cache_bytes,
                "cacheBudgetBytes": self.config.stage.tile_cache_budget_bytes,
                "tileWidth": tiling.tile_width,
                "tileHeight": tiling.tile_height,
                "overscan": tiling.overscan,
            },
            "frame": {
                "frameRateNumerator": 50,
                "frameRateDenominator": 1,
                "currentFrame": self.scenes.values().map(|s| s.frame).max().unwrap_or(0),
                "framesRendered": self.frames_rendered,
                "framesDropped": self.frames_dropped,
                "framesLate": self.frames_late,
                "lastRenderMs": self.last_render_micros as f64 / 1000.0,
                "averageRenderMs": self.last_render_micros as f64 / 1000.0,
                "p99RenderMs": self.last_render_micros as f64 / 1000.0,
                "frameBudgetMs": 20.0,
                "budgetUtilization": (self.last_render_micros as f64 / 1000.0) / 20.0,
            },
            "resourceGovernor": {
                "residentScenes": self.resource_governor.resident_count(),
                "residentSceneTarget": self.resource_governor.budget().resident_scene_target,
                "committedCpuBytes": self.resource_governor.committed().cpu_bytes(),
                "committedGpuBytes": self.resource_governor.committed().gpu_bytes(),
                "reservedCpuBytes": self.resource_governor.reserved().cpu_bytes(),
                "reservedGpuBytes": self.resource_governor.reserved().gpu_bytes(),
                "cpuBudgetBytes": self.resource_governor.budget().cpu_bytes,
                "gpuBudgetBytes": self.resource_governor.budget().gpu_bytes,
            },
            "render": {
                "backend": self.capabilities.gpu.backend,
                "drawCalls": 0,
                "textureCount": tracked,
                "bufferCount": 0,
                "pipelineCount": 0,
                "estimatedVramBytes": cache_bytes,
                "renderPasses": active,
            },
            // Real numbers from the asset store. These were hardcoded zeros while asset
            // sync was unimplemented, which made a stalled transfer invisible.
            "assets": {
                "registeredAssets": self.assets.records().count(),
                "readyAssets": self.assets.ready_count(),
                "loadingAssets": self.assets.records().filter(|record| {
                    record.fetch_state == crate::assets::AssetFetchState::Fetching
                }).count(),
                "failedAssets": self.assets.failed_count(),
                "diskBytes": self.assets.cached_bytes(),
                "decodedCpuBytes": 0,
                "gpuBytes": cache_bytes,
                "cpuBudgetBytes": self.config.assets.cpu_cache_budget_bytes,
                "gpuBudgetBytes": self.config.assets.gpu_cache_budget_bytes,
                "detail": self.assets.summary(),
            },
            "outputs": self.outputs.iter().map(|o| o.status()).collect::<Vec<_>>(),
            "network": {
                "connectedClients": self.connected_clients,
                "lastLatencyMs": 0,
                "averageLatencyMs": 0,
                "messagesReceived": self.messages_received,
                "messagesSent": self.messages_sent,
                "duplicatesDropped": self.duplicates_dropped,
                "sequenceGaps": self.sequence_gaps,
                "resyncCount": self.resync_count,
            },
            "warnings": self.warnings,
            "errors": self.errors,
            // Where recordings and the content cache actually live, absolute, so a tool does
            // not have to guess at a path that is relative to wherever the config file was.
            "cacheDirectory": std::path::Path::new(&self.config.assets.cache_directory)
                .canonicalize()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|_| self.config.assets.cache_directory.clone()),
        });

        if include_tiles {
            if let Some(object) = status.as_object_mut() {
                object.insert(
                    "gpuAdapter".to_string(),
                    json!(self.capabilities.gpu.adapter),
                );
                object.insert(
                    "gpuBackend".to_string(),
                    json!(self.capabilities.gpu.backend),
                );
                object.insert(
                    "gpuLimits".to_string(),
                    json!({
                        "maxTextureDimension2d": self.capabilities.limits.max_texture_dimension_2d,
                        "maxBufferSize": self.capabilities.limits.max_buffer_size,
                        "maxBindGroups": self.capabilities.limits.max_bind_groups,
                    }),
                );
                object.insert("tileDetail".to_string(), Value::Array(tile_detail));
                object.insert(
                    "stateHistory".to_string(),
                    serde_json::to_value(self.state.recent_history(16)).unwrap_or(Value::Null),
                );
                object.insert(
                    "configPath".to_string(),
                    json!(self
                        .config
                        .source_path
                        .as_ref()
                        .map(|path| path.display().to_string())),
                );
                object.insert("assetRoots".to_string(), json!(self.config.assets.roots));
            }
        }

        status
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn tiling_for(&self, stage: &StageDocument) -> TilingConfig {
        // The stage decides whether to tile; the engine's configuration supplies
        // the budgets, because those are properties of this machine.
        TilingConfig {
            enabled: stage.tiling.enabled,
            tile_width: stage.tiling.tile_width,
            tile_height: stage.tiling.tile_height,
            overscan: stage.tiling.overscan,
            max_resident_tiles: self.config.stage.max_resident_tiles,
            cache_budget_bytes: self.config.stage.tile_cache_budget_bytes,
        }
        .normalized()
    }

    fn require_scene(&self, scene_id: &str) -> Result<&LoadedScene, ProtocolError> {
        self.scenes.get(scene_id).ok_or_else(|| {
            ProtocolError::new(ErrorCode::SceneNotFound, format!("no scene {scene_id}"))
        })
    }

    /// Reject a command that names a revision the engine does not hold.
    fn check_revision(&self, payload: &Value, scene_id: &str) -> Result<(), ProtocolError> {
        let Some(expected) = payload.get("sceneRevision").and_then(Value::as_u64) else {
            return Ok(());
        };
        let scene = self.require_scene(scene_id)?;

        if scene.revision != expected {
            return Err(ProtocolError::new(
                ErrorCode::RevisionMismatch,
                format!(
                    "command names revision {expected} but the engine holds {} for {scene_id}",
                    scene.revision
                ),
            ));
        }
        Ok(())
    }

    fn stage_for_scene_ref(&self, scene_id: &str) -> Result<&StageDocument, ProtocolError> {
        let scene = self.require_scene(scene_id)?;
        let stage_id = scene.stage_id.as_deref().ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::StageNotFound,
                format!("scene {scene_id} has no resolved stage"),
            )
        })?;
        self.stages.get(stage_id).ok_or_else(|| {
            ProtocolError::new(ErrorCode::StageNotFound, format!("no stage {stage_id}"))
        })
    }

    pub fn stage_for_scene(&self, scene_id: &str) -> Result<StageDocument, ProtocolError> {
        let scene = self.require_scene(scene_id)?;

        if let Some(stage_id) = &scene.stage_id {
            if let Some(stage) = self.stages.get(stage_id) {
                return Ok(stage.clone());
            }
        }
        Ok(StageDocument::implicit(
            format!("stage_implicit_{scene_id}"),
            1920.0,
            1080.0,
        ))
    }

    fn viewport_rects(&self, stage: &StageDocument) -> Vec<Rect> {
        let rects: Vec<Rect> = stage
            .viewports
            .iter()
            .filter(|viewport| viewport.enabled)
            .map(|viewport| stage.resolve_viewport(viewport))
            .filter(|rect| !rect.is_empty())
            .collect();

        if rects.is_empty() {
            // No viewport declared means the whole stage is of interest.
            vec![stage.bounds()]
        } else {
            rects
        }
    }

    pub fn audit_len(&self) -> usize {
        self.audit.len()
    }

    pub fn scene_count(&self) -> usize {
        self.scenes.len()
    }

    pub fn stage_count(&self) -> usize {
        self.stages.len()
    }
}

// ---------------------------------------------------------------------------
// Scene object extraction
// ---------------------------------------------------------------------------

/// Extract per-object bounds and filter extents for the tile index.
///
/// Objects with no determinable extent are given the stage-wide fallback below
/// rather than being skipped: a missed object is a missing graphic, which is far
/// worse than an over-selected tile.
pub fn scene_object_bounds(scene: &Value) -> Vec<(String, Rect, Vec<FilterOverscan>)> {
    let Some(objects) = scene.get("objects").and_then(Value::as_array) else {
        return Vec::new();
    };

    let canvas_width = scene
        .get("canvas")
        .and_then(|canvas| canvas.get("width"))
        .and_then(Value::as_f64)
        .unwrap_or(1920.0);
    let canvas_height = scene
        .get("canvas")
        .and_then(|canvas| canvas.get("height"))
        .and_then(Value::as_f64)
        .unwrap_or(1080.0);

    let mut result = Vec::new();

    for object in objects {
        let Some(entry) = object.as_object() else {
            continue;
        };

        let object_id = match entry.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => continue,
        };

        // Layers and groups carry no pixels of their own.
        if entry
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "layer" || kind == "group" || kind == "marker")
        {
            continue;
        }

        if entry.get("visible").and_then(Value::as_bool) == Some(false) {
            continue;
        }

        let x = entry.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = entry.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        let width = entry.get("width").and_then(Value::as_f64);
        let height = entry.get("height").and_then(Value::as_f64);

        let bounds = match width {
            Some(width) if width > 0.0 => {
                let height = height.filter(|value| *value > 0.0).unwrap_or(width);
                // Pad for anchors, rotation, and scale, which can push the drawn
                // area outside the nominal rectangle.
                let padding = width.max(height) * 0.5;
                Rect::new(
                    x - padding,
                    y - padding,
                    width + padding * 2.0,
                    height + padding * 2.0,
                )
            }
            // Text, meshes, lines and paths have no simple extent in the document.
            // Assume the whole canvas rather than risk dropping them.
            _ => Rect::new(0.0, 0.0, canvas_width, canvas_height),
        };

        result.push((object_id, bounds, Vec::new()));
    }

    result
}

fn require_str<'a>(payload: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::new(ErrorCode::InvalidPayload, format!("missing {key}")))
}

fn require_channel(payload: &Value) -> Result<Channel, ProtocolError> {
    payload
        .get("channel")
        .and_then(Value::as_str)
        .and_then(Channel::parse)
        .ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                "channel must be preview, program, or auxiliary",
            )
        })
}

/// Map an asset rejection onto a protocol error.
///
/// The distinction that matters: a checksum mismatch and a refused path are the client's
/// problem to fix, while an I/O failure is the engine's. Reporting the second as the first
/// would send a client into a retry loop against a full disk.
fn asset_error(rejection: crate::assets::AssetRejection) -> ProtocolError {
    use crate::assets::AssetRejection;

    let code = match &rejection {
        AssetRejection::MalformedDigest
        | AssetRejection::ChunkIndexOutOfRange
        | AssetRejection::SessionMismatch => ErrorCode::InvalidPayload,
        AssetRejection::UnknownAsset => ErrorCode::AssetNotFound,
        AssetRejection::TooLarge | AssetRejection::ChunkTooLarge => ErrorCode::UploadTooLarge,
        // `AssetRejected` rather than a bespoke code: the contract's code set is fixed, and
        // the rejection's own code travels in the message so nothing is lost.
        AssetRejection::ChecksumMismatch => ErrorCode::AssetRejected,
        AssetRejection::PathRefused(_) => ErrorCode::PathNotPermitted,
        AssetRejection::FetchRefused(_) => ErrorCode::AssetRejected,
        AssetRejection::StillReferenced(_) => ErrorCode::AssetRejected,
        AssetRejection::Io(_) => ErrorCode::InternalError,
    };
    ProtocolError::new(
        code,
        format!("{}: {}", rejection.code(), rejection.message()),
    )
}

/// Decode base64 chunk data.
fn base64_decode(encoded: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())
}
