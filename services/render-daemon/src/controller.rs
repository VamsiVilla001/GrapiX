//! Daemon controller: owns the scene state, the output state machine, and
//! the render/output threads. WebSocket connections call into this through
//! an `Arc<tokio::sync::Mutex<DaemonController>>`.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tokio::sync::{broadcast, watch};

use crate::asset_cache::{descriptors_from_scene, AssetCacheManager, AssetPriority};
use crate::config::OutputConfig;
use crate::output::create_output;
use crate::protocol::{
    ErrorCode, ExpectedRendererState, GpuStatus, LifecycleSceneStatus, OutputStatus, ProtocolError,
    RendererEvent, ResourceStatus, ScenePatch, SceneStatus, StatusReport,
};
use crate::renderer::{gpu::GpuContext, spawn_render_loop, RenderStats};
use crate::resource::{QualityProfile, ResourceGovernor};
use crate::scene::{
    estimate_prepared_scene_bytes, prepare_scene, PreparedScene, SceneLifecycleStatus,
    SceneRegistry, SceneRegistryError,
};

/// Frames buffered between the render thread and the output thread.
/// Two slots = double buffering: one frame in flight to the output while the
/// next renders. When the output stalls, try_send fails and the frame is
/// dropped + counted instead of blocking the render clock.
const FRAME_CHANNEL_CAPACITY: usize = 2;

enum OutputState {
    Idle,
    Configured {
        config: OutputConfig,
    },
    Running {
        config: OutputConfig,
        stop: Arc<AtomicBool>,
        render_thread: std::thread::JoinHandle<()>,
        output_thread: std::thread::JoinHandle<()>,
    },
}

pub struct DaemonController {
    gpu: Arc<GpuContext>,
    scene_tx: watch::Sender<Option<Arc<PreparedScene>>>,
    scene_rx: watch::Receiver<Option<Arc<PreparedScene>>>,
    scenes: SceneRegistry,
    asset_cache: AssetCacheManager,
    governor: ResourceGovernor,
    output_state: OutputState,
    stats: Arc<RenderStats>,
    event_tx: broadcast::Sender<RendererEvent>,
    event_sequence: AtomicU64,
    pub connected_clients: Arc<AtomicUsize>,
}

impl DaemonController {
    pub fn new(gpu: Arc<GpuContext>) -> Self {
        let (scene_tx, scene_rx) = watch::channel(None);
        let (event_tx, _) = broadcast::channel(256);
        let governor = ResourceGovernor::new(QualityProfile::default());
        let limits = governor.limits();

        Self {
            gpu,
            scene_tx,
            scene_rx,
            scenes: SceneRegistry::new(limits.max_warm_scenes, limits.max_prepared_cache_bytes),
            asset_cache: AssetCacheManager::new(
                limits.max_decoded_cpu_cache_bytes,
                limits.max_gpu_asset_cache_bytes,
            ),
            governor,
            output_state: OutputState::Idle,
            stats: Arc::new(RenderStats::default()),
            event_tx,
            event_sequence: AtomicU64::new(0),
            connected_clients: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Load a full scene and make it Program, preserving protocol v1's
    /// load-and-render behavior while v2 adds explicit warm/preview/take.
    pub fn load_scene(&mut self, scene_json: &Value) -> Result<Vec<String>, ProtocolError> {
        let (scene_id, revision, mut warnings) = self.prepare_and_cache_scene(scene_json)?;
        warnings.extend(self.take_program(&scene_id, &revision)?);
        Ok(warnings)
    }

    /// Replace a cached revision without changing channel ownership.
    pub fn update_scene(&mut self, scene_json: &Value) -> Result<Vec<String>, ProtocolError> {
        let (_, _, warnings) = self.prepare_and_cache_scene(scene_json)?;
        Ok(warnings)
    }

    /// Prepare a scene into the bounded warm cache without changing channels.
    pub fn warm_scene(&mut self, scene_json: &Value) -> Result<Vec<String>, ProtocolError> {
        self.update_scene(scene_json)
    }

    /// Apply a small revision-safe patch off the render thread. The prepared
    /// result is published over a watch channel, so bursts naturally coalesce
    /// to the latest revision and the render loop observes it only between
    /// frames.
    pub fn patch_scene(
        &mut self,
        scene_id: &str,
        expected_revision: &str,
        next_revision: &str,
        patch: &ScenePatch,
    ) -> Result<Vec<String>, ProtocolError> {
        let current = self
            .scenes
            .scene(scene_id, expected_revision)
            .map_err(scene_registry_error)?;
        let mut document = current.source_document.clone();
        apply_scene_patch(&mut document, patch)?;
        document["updatedAt"] = Value::String(next_revision.to_string());
        let (prepared_id, prepared_revision, warnings) = self.prepare_and_cache_scene(&document)?;
        if prepared_id != scene_id || prepared_revision != next_revision {
            return Err(ProtocolError::new(
                ErrorCode::RevisionMismatch,
                "patched scene identity or next revision changed during preparation",
            ));
        }
        Ok(warnings)
    }

    pub fn set_preview(
        &mut self,
        scene_id: &str,
        revision: &str,
    ) -> Result<Vec<String>, ProtocolError> {
        let evicted = self
            .scenes
            .set_preview(scene_id, revision)
            .map_err(scene_registry_error)?;
        for evicted_id in &evicted {
            self.asset_cache.release_scene(evicted_id);
        }
        self.sync_asset_priorities();
        self.emit_event(
            "channel.changed",
            serde_json::json!({ "channel": "preview", "sceneId": scene_id, "revision": revision }),
        );
        tracing::info!(scene = scene_id, revision, "Preview scene changed");
        Ok(eviction_warnings(evicted))
    }

    pub fn take_program(
        &mut self,
        scene_id: &str,
        revision: &str,
    ) -> Result<Vec<String>, ProtocolError> {
        let (scene, evicted) = self
            .scenes
            .take_program(scene_id, revision)
            .map_err(scene_registry_error)?;
        for evicted_id in &evicted {
            self.asset_cache.release_scene(evicted_id);
        }
        self.sync_asset_priorities();
        self.scene_tx
            .send(Some(scene))
            .map_err(|_| ProtocolError::new(ErrorCode::RendererError, "scene channel closed"))?;
        tracing::info!(scene = scene_id, revision, "scene taken to Program");
        self.emit_event(
            "channel.changed",
            serde_json::json!({ "channel": "program", "sceneId": scene_id, "revision": revision }),
        );
        Ok(eviction_warnings(evicted))
    }

    pub fn release_scene(&mut self, scene_id: &str, revision: &str) -> Result<(), ProtocolError> {
        self.scenes
            .release(scene_id, revision)
            .map_err(scene_registry_error)?;
        self.asset_cache.release_scene(scene_id);
        self.emit_event(
            "scene.lifecycle",
            serde_json::json!({ "sceneId": scene_id, "revision": revision, "lifecycle": "UNLOADED" }),
        );
        tracing::info!(scene = scene_id, revision, "scene released");
        Ok(())
    }

    fn prepare_and_cache_scene(
        &mut self,
        scene_json: &Value,
    ) -> Result<(String, String, Vec<String>), ProtocolError> {
        let prepared = prepare_scene(scene_json)
            .map_err(|error| ProtocolError::new(ErrorCode::InvalidScene, error.to_string()))?;
        self.governor
            .validate_prepared_scene(estimate_prepared_scene_bytes(&prepared))
            .map_err(|error| ProtocolError::new(ErrorCode::RendererError, error))?;

        for warning in &prepared.warnings {
            tracing::warn!(scene = %prepared.scene_id, "{warning}");
        }

        tracing::info!(
            scene = %prepared.scene_id,
            name = %prepared.name,
            objects = prepared.object_count,
            rects = prepared.rects.len(),
            warnings = prepared.warnings.len(),
            "scene loaded"
        );

        let scene_id = prepared.scene_id.clone();
        let revision = prepared.revision.clone();
        let was_program = self.scenes.program_scene_id() == Some(scene_id.as_str());
        let scene = Arc::new(prepared);
        let mut warnings = scene.warnings.clone();
        let evicted = self.scenes.insert(Arc::clone(&scene));
        self.asset_cache.sync_scene(
            &scene_id,
            descriptors_from_scene(scene_json),
            if was_program {
                AssetPriority::Program
            } else if self.scenes.preview_scene_id() == Some(scene_id.as_str()) {
                AssetPriority::Preview
            } else {
                AssetPriority::Warm
            },
        );
        for evicted_id in &evicted {
            self.asset_cache.release_scene(evicted_id);
        }
        warnings.extend(eviction_warnings(evicted));

        if was_program {
            self.scene_tx.send(Some(scene)).map_err(|_| {
                ProtocolError::new(ErrorCode::RendererError, "scene channel closed")
            })?;
        }
        self.emit_event(
            "scene.lifecycle",
            serde_json::json!({
                "sceneId": scene_id,
                "revision": revision,
                "lifecycle": if was_program { "PROGRAM" } else { "WARM" }
            }),
        );

        Ok((scene_id, revision, warnings))
    }

    pub fn validate_expected_state(
        &self,
        expected: ExpectedRendererState,
    ) -> Result<(), ProtocolError> {
        let matches = match expected {
            ExpectedRendererState::Any => true,
            ExpectedRendererState::Idle => matches!(&self.output_state, OutputState::Idle),
            ExpectedRendererState::Configured => {
                matches!(&self.output_state, OutputState::Configured { .. })
            }
            ExpectedRendererState::Running => {
                matches!(&self.output_state, OutputState::Running { .. })
            }
        };

        if matches {
            Ok(())
        } else {
            Err(ProtocolError::new(
                ErrorCode::ExpectedStateMismatch,
                format!(
                    "expected renderer state {}, current state is {}",
                    expected.as_str(),
                    self.output_state_name()
                ),
            ))
        }
    }

    pub fn set_quality_profile(&mut self, profile: QualityProfile) -> Vec<String> {
        let limits = self.governor.set_profile(profile);
        let evicted = self
            .scenes
            .set_limits(limits.max_warm_scenes, limits.max_prepared_cache_bytes);
        self.asset_cache.set_budgets(
            limits.max_decoded_cpu_cache_bytes,
            limits.max_gpu_asset_cache_bytes,
        );
        for evicted_id in &evicted {
            self.asset_cache.release_scene(evicted_id);
        }
        self.sync_asset_priorities();
        tracing::info!(
            profile = ?profile,
            max_warm_scenes = limits.max_warm_scenes,
            max_cache_bytes = limits.max_prepared_cache_bytes,
            "renderer quality profile changed"
        );
        self.emit_event(
            "renderer.state",
            serde_json::json!({ "qualityProfile": profile }),
        );
        eviction_warnings(evicted)
    }

    fn output_state_name(&self) -> &'static str {
        match &self.output_state {
            OutputState::Idle => "idle",
            OutputState::Configured { .. } => "configured",
            OutputState::Running { .. } => "running",
        }
    }

    pub fn configure_output(&mut self, config: OutputConfig) -> Result<(), ProtocolError> {
        if matches!(self.output_state, OutputState::Running { .. }) {
            return Err(ProtocolError::new(
                ErrorCode::OutputStateError,
                "output is running; send output.stop before output.configure",
            ));
        }
        self.governor
            .validate_output(&config)
            .map_err(|error| ProtocolError::new(ErrorCode::InvalidOutputConfig, error))?;

        tracing::info!(
            width = config.width,
            height = config.height,
            fps = format!("{}/{}", config.frame_rate.numerator, config.frame_rate.denominator),
            backend = ?config.backend,
            ndi_source = %config.ndi_source_name,
            "output configured"
        );

        self.output_state = OutputState::Configured { config };
        self.emit_event(
            "output.health",
            serde_json::json!({ "state": "configured" }),
        );

        Ok(())
    }

    pub fn start_output(&mut self) -> Result<(), ProtocolError> {
        let config = match &self.output_state {
            OutputState::Idle => {
                return Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "no output configuration; send output.configure before output.start",
                ))
            }
            OutputState::Running { .. } => {
                return Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "output is already running",
                ))
            }
            OutputState::Configured { config } => config.clone(),
        };
        let mut output = create_output(&config)
            .map_err(|error| ProtocolError::new(ErrorCode::RendererError, error.to_string()))?;
        output
            .configure(&config)
            .and_then(|()| output.start())
            .map_err(|error| ProtocolError::new(ErrorCode::RendererError, error.to_string()))?;

        let (frame_tx, frame_rx) = mpsc::sync_channel(FRAME_CHANNEL_CAPACITY);
        let stop = Arc::new(AtomicBool::new(false));
        let stats = Arc::clone(&self.stats);

        stats.reset_for_output();

        let render_thread = spawn_render_loop(
            Arc::clone(&self.gpu),
            config.clone(),
            self.scene_rx.clone(),
            frame_tx,
            Arc::clone(&stop),
            Arc::clone(&stats),
        );

        let output_stats = Arc::clone(&stats);
        let output_thread = std::thread::Builder::new()
            .name("grapix-output".to_string())
            .spawn(move || {
                // Consumes frames until the render loop drops its sender.
                // NDI network sends happen here, off the render thread.
                while let Ok(frame) = frame_rx.recv() {
                    match output.send_frame(&frame) {
                        Ok(()) => {
                            output_stats.frames_sent.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            tracing::error!(%error, backend = output.name(), "failed to send frame");
                            output_stats.record_error(&error);
                        }
                    }
                }

                if let Err(error) = output.stop() {
                    tracing::warn!(%error, "output stop reported an error");
                }
            })
            .expect("failed to spawn output thread");

        self.output_state = OutputState::Running {
            config,
            stop,
            render_thread,
            output_thread,
        };
        self.emit_event("output.health", serde_json::json!({ "state": "running" }));

        Ok(())
    }

    pub fn stop_output(&mut self) -> Result<(), ProtocolError> {
        match std::mem::replace(&mut self.output_state, OutputState::Idle) {
            OutputState::Running {
                config,
                stop,
                render_thread,
                output_thread,
            } => {
                stop.store(true, Ordering::Relaxed);
                // Wake the frame clock immediately. `park_timeout` preserves
                // deadline pacing while `unpark` makes stop/shutdown prompt,
                // even at the minimum supported frame rate.
                render_thread.thread().unpark();

                // The render thread may still finish an in-flight GPU
                // readback, but it no longer waits out the next frame period.
                if render_thread.join().is_err() {
                    tracing::error!("render thread panicked");
                }
                if output_thread.join().is_err() {
                    tracing::error!("output thread panicked");
                }

                tracing::info!("output stopped");
                self.output_state = OutputState::Configured { config };
                self.emit_event(
                    "output.health",
                    serde_json::json!({ "state": "configured" }),
                );

                Ok(())
            }
            OutputState::Configured { config } => {
                // Stopping a non-running output keeps the configuration.
                self.output_state = OutputState::Configured { config };
                Err(ProtocolError::new(
                    ErrorCode::OutputStateError,
                    "output is not running",
                ))
            }
            OutputState::Idle => Err(ProtocolError::new(
                ErrorCode::OutputStateError,
                "output is not running",
            )),
        }
    }

    /// Called on daemon shutdown; unlike `stop_output` it never errors.
    pub fn shutdown(&mut self) {
        if matches!(self.output_state, OutputState::Running { .. }) {
            if let Err(error) = self.stop_output() {
                tracing::warn!(%error, "error while stopping output during shutdown");
            }
        }
    }

    pub fn status(&self) -> StatusReport {
        let scene = self.scenes.program_scene().map(|scene| SceneStatus {
            id: scene.scene_id.clone(),
            name: scene.name.clone(),
            revision: scene.revision.clone(),
            object_count: scene.object_count,
            rect_count: scene.rects.len(),
            mesh_count: scene.meshes.len(),
            warnings: scene.warnings.clone(),
            take_ready: scene.take_blockers.is_empty(),
            take_blockers: scene.take_blockers.clone(),
        });

        let config = match &self.output_state {
            OutputState::Idle => None,
            OutputState::Configured { config } | OutputState::Running { config, .. } => {
                Some(config.clone())
            }
        };
        let timing = self.stats.timing_snapshot();
        let frame_budget_ms = config
            .as_ref()
            .map(|config| config.frame_rate.frame_duration_nanos() as f64 / 1_000_000.0)
            .unwrap_or_default();
        let limits = self.governor.limits();
        let estimated_cache_bytes = self.scenes.estimated_cache_bytes();
        let cache_pressure = if limits.max_prepared_cache_bytes == 0 {
            1.0
        } else {
            estimated_cache_bytes as f64 / limits.max_prepared_cache_bytes as f64
        };

        StatusReport {
            connected_clients: self.connected_clients.load(Ordering::Relaxed),
            scene,
            scenes: self
                .scenes
                .statuses()
                .into_iter()
                .map(lifecycle_status)
                .collect(),
            program_scene_id: self.scenes.program_scene_id().map(str::to_string),
            preview_scene_id: self.scenes.preview_scene_id().map(str::to_string),
            warm_scene_count: self.scenes.warm_scene_count(),
            max_warm_scenes: self.scenes.max_warm_scenes(),
            estimated_cache_bytes,
            asset_cache: self.asset_cache.status(),
            resources: ResourceStatus {
                profile: self.governor.profile(),
                limits,
                cache_pressure,
                over_budget: cache_pressure > 1.0,
            },
            gpu: GpuStatus {
                adapter: self.gpu.adapter_info.name.clone(),
                backend: self.gpu.adapter_info.backend.to_string(),
                device_type: format!("{:?}", self.gpu.adapter_info.device_type),
                driver: self.gpu.adapter_info.driver.clone(),
                driver_info: self.gpu.adapter_info.driver_info.clone(),
                vendor_id: self.gpu.adapter_info.vendor,
                device_id: self.gpu.adapter_info.device,
                max_texture_dimension_2d: self.gpu.limits.max_texture_dimension_2d,
                max_buffer_size: self.gpu.limits.max_buffer_size,
                max_bind_groups: self.gpu.limits.max_bind_groups,
            },
            output: OutputStatus {
                state: self.output_state_name().to_string(),
                config,
                frames_rendered: self.stats.frames_rendered.load(Ordering::Relaxed),
                frames_sent: self.stats.frames_sent.load(Ordering::Relaxed),
                frames_dropped: self.stats.frames_dropped.load(Ordering::Relaxed),
                last_render_ms: self.stats.last_render_micros.load(Ordering::Relaxed) as f64
                    / 1000.0,
                timing_sample_count: timing.sample_count,
                average_render_ms: timing.average_ms,
                p99_render_ms: timing.p99_ms,
                frame_budget_ms,
                average_budget_utilization: if frame_budget_ms > 0.0 {
                    timing.average_ms / frame_budget_ms
                } else {
                    0.0
                },
                p99_budget_utilization: if frame_budget_ms > 0.0 {
                    timing.p99_ms / frame_budget_ms
                } else {
                    0.0
                },
                last_error: self
                    .stats
                    .last_error
                    .lock()
                    .expect("stats mutex poisoned")
                    .clone(),
            },
        }
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<RendererEvent> {
        self.event_tx.subscribe()
    }

    fn sync_asset_priorities(&mut self) {
        for status in self.scenes.statuses() {
            let priority = match status.lifecycle {
                crate::scene::SceneLifecycle::Program => AssetPriority::Program,
                crate::scene::SceneLifecycle::Preview => AssetPriority::Preview,
                crate::scene::SceneLifecycle::Warm => AssetPriority::Warm,
                _ => AssetPriority::Editor,
            };
            self.asset_cache.set_scene_priority(&status.id, priority);
        }
    }

    fn emit_event(&self, event_type: &str, payload: Value) {
        let event_sequence = self.event_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let timestamp_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();
        let _ = self.event_tx.send(RendererEvent {
            message_type: "event",
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            event_type: event_type.to_string(),
            event_sequence,
            timestamp_ms,
            payload,
        });
    }
}

fn apply_scene_patch(document: &mut Value, patch: &ScenePatch) -> Result<(), ProtocolError> {
    match patch {
        ScenePatch::DataContext { path, value, .. } => {
            let data_context = document
                .get_mut("dataContext")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCode::InvalidScene,
                        "scene dataContext must be an object",
                    )
                })?;
            set_object_path(data_context, path, value.clone())
        }
        ScenePatch::SceneProperty {
            object_id,
            property,
            value,
            ..
        } => {
            const ALLOWED: &[&str] = &[
                "text", "fill", "stroke", "src", "visible", "x", "y", "width", "height", "zDepth",
                "rotation", "scaleX", "scaleY", "anchor", "opacity", "path",
            ];
            if !ALLOWED.contains(&property.as_str()) {
                return Err(ProtocolError::new(
                    ErrorCode::InvalidPayload,
                    format!("scene property {property:?} is not patchable"),
                ));
            }
            let objects = document
                .get_mut("objects")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidScene, "scene objects must be an array")
                })?;
            let object = objects
                .iter_mut()
                .find(|object| object.get("id").and_then(Value::as_str) == Some(object_id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        format!("patch target object {object_id:?} does not exist"),
                    )
                })?;
            object.insert(property.clone(), value.clone());
            Ok(())
        }
        ScenePatch::Visibility {
            object_id, value, ..
        } => {
            let objects = document
                .get_mut("objects")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    ProtocolError::new(ErrorCode::InvalidScene, "scene objects must be an array")
                })?;
            let object = objects
                .iter_mut()
                .find(|object| object.get("id").and_then(Value::as_str) == Some(object_id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    ProtocolError::new(
                        ErrorCode::InvalidPayload,
                        format!("patch target object {object_id:?} does not exist"),
                    )
                })?;
            object.insert("visible".to_string(), Value::Bool(*value));
            Ok(())
        }
    }
}

fn set_object_path(
    root: &mut serde_json::Map<String, Value>,
    path: &str,
    value: Value,
) -> Result<(), ProtocolError> {
    if path.is_empty() || path.len() > 256 {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            "data patch path must contain 1 to 256 characters",
        ));
    }
    let normalized = path.replace('[', ".").replace(']', "");
    let segments: Vec<_> = normalized
        .split('.')
        .filter(|part| !part.is_empty())
        .collect();
    if segments.is_empty() || segments.len() > 32 {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            "data patch path must contain 1 to 32 segments",
        ));
    }
    if segments
        .iter()
        .any(|segment| matches!(*segment, "__proto__" | "prototype" | "constructor"))
    {
        return Err(ProtocolError::new(
            ErrorCode::InvalidPayload,
            "data patch path contains a reserved segment",
        ));
    }

    let mut current = root;
    for segment in &segments[..segments.len() - 1] {
        let child = current
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        current = child.as_object_mut().ok_or_else(|| {
            ProtocolError::new(
                ErrorCode::InvalidPayload,
                format!("data patch path crosses non-object segment {segment:?}"),
            )
        })?;
    }
    current.insert(segments[segments.len() - 1].to_string(), value);
    Ok(())
}

fn scene_registry_error(error: SceneRegistryError) -> ProtocolError {
    let code = match &error {
        SceneRegistryError::RevisionMismatch { .. } => ErrorCode::RevisionMismatch,
        SceneRegistryError::ActiveScene(_) => ErrorCode::OutputStateError,
        SceneRegistryError::NotReady { .. } => ErrorCode::InvalidScene,
        SceneRegistryError::UnknownScene(_) => ErrorCode::InvalidScene,
    };
    ProtocolError::new(code, error.to_string())
}

fn eviction_warnings(scene_ids: Vec<String>) -> Vec<String> {
    scene_ids
        .into_iter()
        .map(|scene_id| format!("evicted least-recently-used warm scene {scene_id:?}"))
        .collect()
}

fn lifecycle_status(status: SceneLifecycleStatus) -> LifecycleSceneStatus {
    LifecycleSceneStatus {
        id: status.id,
        name: status.name,
        revision: status.revision,
        lifecycle: status.lifecycle,
        object_count: status.object_count,
        rect_count: status.rect_count,
        mesh_count: status.mesh_count,
        warnings: status.warnings,
        take_ready: status.take_blockers.is_empty(),
        take_blockers: status.take_blockers,
        estimated_bytes: status.estimated_bytes,
        last_used: status.last_used,
    }
}
